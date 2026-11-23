#include "DialInPlugin.h"

#include <ArduinoJson.h>
#include <LittleFS.h>
#include <SD_MMC.h>
#include <cstdlib>
#include <cstring>
#include <display/core/Controller.h>
#include <display/core/PluginManager.h>
#include <display/core/ProfileManager.h>
#include <display/models/profile.h>
#include <display/plugins/dialin/app_bundle.h>

static constexpr const char *TAG = "DialInPlugin";
static constexpr const char *ROOT_DIR = "/dialin";
static constexpr const char *WWW_DIR = "/dialin/www/";
static constexpr const char *INDEX_PATH = "/dialin/www/index.html";
static constexpr const char *DATA_DIR = "/dialin/data";
static constexpr const char *LIMITS_PATH = "/dialin/limits.json";
static constexpr const char *DATA_PREFIX = "/api/dialin/data/";
static constexpr size_t MAX_BODY = 64 * 1024;

DialInPlugin DialIn;

// ---------------------------------------------------------------- body helpers
// The real ESPAsyncWebServer delivers request bodies in chunks; we collect them
// into one malloc'd block on request->_tempObject, which the library frees.
// The desktop simulator's server already hands over the whole body.

namespace {

using BodyHandler = std::function<void(AsyncWebServerRequest *, const std::string &)>;

#ifndef GAGGIMATE_SIM
struct BodyBuffer {
    size_t len;
    size_t received;
    // followed by len bytes of data
    char *data() { return reinterpret_cast<char *>(this + 1); }
};

void collectBody(AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
    if (index == 0) {
        if (total > MAX_BODY || request->_tempObject != nullptr)
            return;
        auto *buf = static_cast<BodyBuffer *>(malloc(sizeof(BodyBuffer) + total));
        if (buf == nullptr)
            return;
        buf->len = total;
        buf->received = 0;
        request->_tempObject = buf;
    }
    auto *buf = static_cast<BodyBuffer *>(request->_tempObject);
    if (buf == nullptr || index + len > buf->len)
        return;
    memcpy(buf->data() + index, data, len);
    buf->received += len;
}

bool readBody(AsyncWebServerRequest *request, std::string &out) {
    auto *buf = static_cast<BodyBuffer *>(request->_tempObject);
    if (buf == nullptr) {
        out.clear();
        return request->contentLength() == 0;
    }
    if (buf->received != buf->len)
        return false;
    out.assign(buf->data(), buf->len);
    return true;
}
#else
bool readBody(AsyncWebServerRequest *request, std::string &out) {
    if (request->_body.size() > MAX_BODY)
        return false;
    out = request->_body;
    return true;
}
#endif

void withBody(AsyncWebServerRequest *request, const BodyHandler &handler) {
    std::string body;
    if (!readBody(request, body)) {
        request->send(413, "application/json", "{\"ok\":false,\"errors\":[\"Request body too large or incomplete.\"]}");
        return;
    }
    handler(request, body);
}

void onWithBody(AsyncWebServer &server, const char *uri, WebRequestMethod method, BodyHandler handler) {
#ifndef GAGGIMATE_SIM
    server.on(
        uri, method, [handler](AsyncWebServerRequest *request) { withBody(request, handler); }, nullptr, collectBody);
#else
    server.on(uri, method, [handler](AsyncWebServerRequest *request) { withBody(request, handler); });
#endif
}

void sendJson(AsyncWebServerRequest *request, int code, JsonDocument &doc) {
    String out;
    serializeJson(doc, out);
    request->send(code, "application/json", out);
}

void sendError(AsyncWebServerRequest *request, int code, const char *message) {
    JsonDocument doc;
    doc["ok"] = false;
    doc["errors"].to<JsonArray>().add(message);
    sendJson(request, code, doc);
}

bool ensureDir(fs::FS &fs, const String &path) {
    if (fs.exists(path))
        return true;
    // create each component
    int from = 1;
    while (true) {
        int slash = path.indexOf('/', from);
        String part = slash < 0 ? path : path.substring(0, slash);
        if (!fs.exists(part) && !fs.mkdir(part))
            return false;
        if (slash < 0)
            return true;
        from = slash + 1;
    }
}

const char *FALLBACK_PAGE =
    "<!doctype html><meta name=viewport content='width=device-width'><title>Dial-in</title>"
    "<body style='font-family:sans-serif;max-width:32em;margin:2em auto;padding:0 1em'>"
    "<h1>Dial-in app not installed</h1><p>The Dial-in plugin is running, but the app files were not found on the SD card.</p>"
    "<p>The firmware copies them onto the card when it starts. Check that an SD card is fitted, then restart the machine.</p></body>";

} // namespace

// ---------------------------------------------------------------- plugin

void DialInPlugin::setup(Controller *_controller, PluginManager *_pluginManager) {
    controller = _controller;
    pluginManager = _pluginManager;
    loadLimits();
    installApp();
    ESP_LOGI(TAG, "Dial-in plugin %s ready (storage: %s)", DIALIN_PLUGIN_VERSION, storage() ? "yes" : "no SD card");
}

fs::FS *DialInPlugin::storage() const {
    if (controller != nullptr && controller->isSDCard())
        return &SD_MMC;
#ifdef GAGGIMATE_SIM
    return &LittleFS; // the simulator has no SD card; use its LittleFS folder instead
#else
    return nullptr;
#endif
}

bool DialInPlugin::isValidName(const String &name) {
    if (name.length() == 0 || name.length() > 40)
        return false;
    for (size_t i = 0; i < name.length(); i++) {
        char c = name[i];
        bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
        if (!ok)
            return false;
    }
    return true;
}

// ---------------------------------------------------------------- app files

// Copies the web app built into the firmware onto the card when the card holds
// a different version (or none). Files the user added are left alone.
void DialInPlugin::installApp() {
    fs::FS *fs = storage();
    if (fs == nullptr)
        return;
    const String marker = String(WWW_DIR) + ".version";
    if (fs->exists(marker)) {
        File m = fs->open(marker, "r");
        String current = m ? m.readString() : String();
        if (m)
            m.close();
        current.trim();
        if (current == dialin_app::VERSION)
            return;
    }
    size_t written = 0;
    for (size_t i = 0; i < dialin_app::FILE_COUNT; i++) {
        const auto &file = dialin_app::FILES[i];
        String path = String(WWW_DIR) + file.path;
        String dir = path.substring(0, path.lastIndexOf('/'));
        if (!ensureDir(*fs, dir)) {
            ESP_LOGW(TAG, "Could not create %s", dir.c_str());
            return;
        }
        String tmp = path + ".tmp";
        File f = fs->open(tmp, "w");
        if (!f) {
            ESP_LOGW(TAG, "Could not write %s", tmp.c_str());
            return;
        }
        size_t n = f.write(file.data, file.size);
        f.close();
        if (n != file.size) {
            fs->remove(tmp);
            ESP_LOGW(TAG, "Short write for %s", path.c_str());
            return;
        }
        if (fs->exists(path))
            fs->remove(path);
        fs->rename(tmp.c_str(), path.c_str());
        written += n;
    }
    File m = fs->open(marker, "w");
    if (m) {
        m.print(dialin_app::VERSION);
        m.close();
    }
    ESP_LOGI(TAG, "Installed Dial-in app %s (%u files, %u bytes)", dialin_app::VERSION, (unsigned)dialin_app::FILE_COUNT,
             (unsigned)written);
}

// ---------------------------------------------------------------- limits

#define DIALIN_LIMIT_FIELDS(X)                                                                                                   \
    X(maxPressure)                                                                                                               \
    X(maxPreinfusionPressure)                                                                                                    \
    X(minTemperature)                                                                                                            \
    X(maxTemperature)                                                                                                            \
    X(minFlow)                                                                                                                   \
    X(maxFlow)                                                                                                                   \
    X(maxPhaseDuration)                                                                                                          \
    X(maxTotalDuration)                                                                                                          \
    X(maxYield)                                                                                                                  \
    X(maxTemperatureStep)                                                                                                        \
    X(maxPressureStep)                                                                                                           \
    X(maxFlowStep)                                                                                                               \
    X(maxDurationStep)                                                                                                           \
    X(maxYieldStep)

static void readLimits(JsonObjectConst obj, dialin::SafetyLimits &l) {
#define X(f)                                                                                                                     \
    if (obj[#f].is<float>())                                                                                                     \
        l.f = obj[#f].as<float>();
    DIALIN_LIMIT_FIELDS(X)
#undef X
    if (obj["maxPhases"].is<int>())
        l.maxPhases = obj["maxPhases"].as<int>();
    if (obj["maxChangedVariables"].is<int>())
        l.maxChangedVariables = obj["maxChangedVariables"].as<int>();
    l.clampToHard();
}

static void writeLimits(JsonObject obj, const dialin::SafetyLimits &l) {
#define X(f) obj[#f] = l.f;
    DIALIN_LIMIT_FIELDS(X)
#undef X
    obj["maxPhases"] = l.maxPhases;
    obj["maxChangedVariables"] = l.maxChangedVariables;
}

static void writeHardLimits(JsonObject obj) {
    using H = dialin::HardLimits;
    obj["maxPressure"] = H::maxPressure;
    obj["maxPreinfusionPressure"] = H::maxPreinfusionPressure;
    obj["minTemperature"] = H::minTemperature;
    obj["maxTemperature"] = H::maxTemperature;
    obj["minFlow"] = H::minFlow;
    obj["maxFlow"] = H::maxFlow;
    obj["maxPhaseDuration"] = H::maxPhaseDuration;
    obj["maxTotalDuration"] = H::maxTotalDuration;
    obj["maxYield"] = H::maxYield;
    obj["maxPhases"] = H::maxPhases;
}

void DialInPlugin::loadLimits() {
    limits = dialin::SafetyLimits{};
    fs::FS *fs = storage();
    if (fs == nullptr || !fs->exists(LIMITS_PATH)) {
        limits.clampToHard();
        return;
    }
    File f = fs->open(LIMITS_PATH, "r");
    if (!f) {
        limits.clampToHard();
        return;
    }
    JsonDocument doc;
    if (deserializeJson(doc, f) == DeserializationError::Ok)
        readLimits(doc.as<JsonObjectConst>(), limits);
    f.close();
    limits.clampToHard();
}

bool DialInPlugin::saveLimits() {
    fs::FS *fs = storage();
    if (fs == nullptr || !ensureDir(*fs, ROOT_DIR))
        return false;
    File f = fs->open(LIMITS_PATH, "w");
    if (!f)
        return false;
    JsonDocument doc;
    writeLimits(doc.to<JsonObject>(), limits);
    bool ok = serializeJson(doc, f) > 0;
    f.close();
    return ok;
}

// ---------------------------------------------------------------- profile spec

dialin::ProfileSpec DialInPlugin::toSpec(const Profile &profile) {
    dialin::ProfileSpec spec;
    spec.type = profile.type.c_str();
    spec.utility = profile.utility;
    spec.temperature = profile.temperature;
    for (const auto &ph : profile.phases) {
        dialin::PhaseSpec p;
        p.name = ph.name.c_str();
        p.preinfusion = ph.phase == PhaseType::PHASE_TYPE_PREINFUSION;
        p.duration = ph.duration;
        p.simplePump = ph.pumpIsSimple;
        p.simplePercent = ph.pumpSimple;
        p.pressureMode = ph.pumpAdvanced.target == PumpTarget::PUMP_TARGET_PRESSURE;
        p.pressure = ph.pumpAdvanced.pressure;
        p.flow = ph.pumpAdvanced.flow;
        p.temperature = ph.temperature;
        for (const auto &t : ph.targets) {
            dialin::TargetSpec ts{};
            switch (t.type) {
            case TargetType::TARGET_TYPE_VOLUMETRIC:
                ts.kind = dialin::TargetKind::Volumetric;
                break;
            case TargetType::TARGET_TYPE_PRESSURE:
                ts.kind = dialin::TargetKind::Pressure;
                break;
            case TargetType::TARGET_TYPE_FLOW:
                ts.kind = dialin::TargetKind::Flow;
                break;
            default:
                ts.kind = dialin::TargetKind::Pumped;
                break;
            }
            ts.value = t.value;
            p.targets.push_back(ts);
        }
        spec.phases.push_back(p);
    }
    return spec;
}

// ---------------------------------------------------------------- routes

void DialInPlugin::attachRoutes(AsyncWebServer &server) {
    // Exact matchers: a plain "/dialin" route also matches "/dialin/..." on the real
    // server (backward-compatible matching), which made the redirect loop forever.
    server.on(AsyncURIMatcher::exact("/dialin"), HTTP_GET, [](AsyncWebServerRequest *request) { request->redirect("/dialin/"); });
    server.on(AsyncURIMatcher::exact("/dialin/"), HTTP_GET, [this](AsyncWebServerRequest *request) { serveIndex(request); });
    if (fs::FS *fs = storage()) {
        server.serveStatic("/dialin/", *fs, WWW_DIR).setCacheControl("no-cache");
    }

    server.on("/api/dialin/status", HTTP_GET, [this](AsyncWebServerRequest *request) { handleStatus(request); });
    server.on("/api/dialin/limits", HTTP_GET, [this](AsyncWebServerRequest *request) { handleLimitsGet(request); });
    onWithBody(server, "/api/dialin/limits", HTTP_POST,
               [this](AsyncWebServerRequest *request, const std::string &body) { handleLimitsSet(request, body); });
    onWithBody(server, "/api/dialin/profile/check", HTTP_POST,
               [this](AsyncWebServerRequest *request, const std::string &body) { handleProfileCheck(request, body, false); });
    onWithBody(server, "/api/dialin/profile/save", HTTP_POST,
               [this](AsyncWebServerRequest *request, const std::string &body) { handleProfileCheck(request, body, true); });

    BodyHandler dataHandler = [this](AsyncWebServerRequest *request, const std::string &body) { handleData(request, body); };
#ifndef GAGGIMATE_SIM
    server.on(
        AsyncURIMatcher::prefix(DATA_PREFIX), HTTP_ANY, [dataHandler](AsyncWebServerRequest *request) { withBody(request, dataHandler); },
        nullptr, collectBody);
#else
    server.on(AsyncURIMatcher::prefix(DATA_PREFIX), HTTP_ANY,
              [dataHandler](AsyncWebServerRequest *request) { withBody(request, dataHandler); });
#endif
}

void DialInPlugin::serveIndex(AsyncWebServerRequest *request) {
    fs::FS *fs = storage();
    if (fs != nullptr && fs->exists(INDEX_PATH)) {
        request->send(*fs, INDEX_PATH, "text/html");
        return;
    }
    request->send(200, "text/html", FALLBACK_PAGE);
}

void DialInPlugin::handleStatus(AsyncWebServerRequest *request) {
    fs::FS *fs = storage();
    JsonDocument doc;
    doc["ok"] = true;
    doc["version"] = DIALIN_PLUGIN_VERSION;
    doc["sdCard"] = controller->isSDCard();
    doc["storage"] = fs != nullptr;
    doc["appInstalled"] = fs != nullptr && fs->exists(INDEX_PATH);
    doc["appVersion"] = dialin_app::VERSION;
    doc["busy"] = controller->isActive();
    if (controller->isSDCard()) {
        doc["totalBytes"] = (double)SD_MMC.totalBytes();
        doc["usedBytes"] = (double)SD_MMC.usedBytes();
    }
    writeLimits(doc["limits"].to<JsonObject>(), limits);
    writeHardLimits(doc["hardLimits"].to<JsonObject>());
    sendJson(request, 200, doc);
}

void DialInPlugin::handleLimitsGet(AsyncWebServerRequest *request) {
    JsonDocument doc;
    doc["ok"] = true;
    writeLimits(doc["limits"].to<JsonObject>(), limits);
    writeHardLimits(doc["hardLimits"].to<JsonObject>());
    sendJson(request, 200, doc);
}

void DialInPlugin::handleLimitsSet(AsyncWebServerRequest *request, const std::string &body) {
    JsonDocument in;
    if (deserializeJson(in, body) != DeserializationError::Ok || !in.is<JsonObject>()) {
        sendError(request, 400, "Body must be a JSON object of limits.");
        return;
    }
    dialin::SafetyLimits next = limits;
    readLimits(in.as<JsonObjectConst>(), next); // clamps to the hard limits
    limits = next;
    if (!saveLimits()) {
        sendError(request, 503, "Could not save limits (is the SD card fitted?).");
        return;
    }
    handleLimitsGet(request);
}

void DialInPlugin::handleProfileCheck(AsyncWebServerRequest *request, const std::string &body, bool save) {
    JsonDocument in;
    if (deserializeJson(in, body) != DeserializationError::Ok) {
        sendError(request, 400, "Body is not valid JSON.");
        return;
    }
    JsonObject obj = in["profile"].as<JsonObject>();
    Profile profile;
    if (obj.isNull() || !parseProfile(obj, profile)) {
        sendError(request, 400, "Profile is missing required fields (label, type, phases).");
        return;
    }

    ProfileManager *pm = controller->getProfileManager();
    Profile previous;
    bool hasPrevious = false;
    if (!profile.id.isEmpty() && pm->profileExists(profile.id)) {
        hasPrevious = pm->loadProfile(profile.id, previous);
        if (hasPrevious && previous.utility) {
            sendError(request, 403, "Utility profiles can't be changed by the assistant.");
            return;
        }
    }
    dialin::ProfileSpec prevSpec;
    if (hasPrevious)
        prevSpec = toSpec(previous);
    dialin::ProfileSpec spec = toSpec(profile);
    spec.salami = in["salami"] | false;
    auto errors = dialin::validate(spec, limits, hasPrevious ? &prevSpec : nullptr);

    JsonDocument out;
    out["ok"] = errors.empty();
    JsonArray errs = out["errors"].to<JsonArray>();
    for (const auto &e : errors)
        errs.add(e.c_str());

    if (!errors.empty() || !save) {
        sendJson(request, errors.empty() ? 200 : 422, out);
        return;
    }
    if (controller->isActive()) {
        sendError(request, 409, "The machine is busy (brewing, flushing or similar). Try again when it has finished.");
        return;
    }
    if (!pm->saveProfile(profile)) {
        sendError(request, 500, "Saving the profile failed.");
        return;
    }
    if (in["select"] | false)
        pm->selectProfile(profile.id);
    ESP_LOGI(TAG, "Saved checked profile %s", profile.id.c_str());
    out["id"] = profile.id;
    JsonObject saved = out["profile"].to<JsonObject>();
    writeProfile(saved, profile);
    sendJson(request, 200, out);
}

void DialInPlugin::handleData(AsyncWebServerRequest *request, const std::string &body) {
    fs::FS *fs = storage();
    if (fs == nullptr) {
        sendError(request, 503, "No SD card: the Dial-in app needs one to store its data.");
        return;
    }
    String rest = request->url().substring(strlen(DATA_PREFIX));
    while (rest.endsWith("/"))
        rest.remove(rest.length() - 1);
    int slash = rest.indexOf('/');
    String collection = slash < 0 ? rest : rest.substring(0, slash);
    String id = slash < 0 ? String() : rest.substring(slash + 1);
    if (!isValidName(collection) || (slash >= 0 && !isValidName(id))) {
        sendError(request, 400, "Collection and record names may only use a-z, 0-9, '-' and '_' (max 40).");
        return;
    }
    String dir = String(DATA_DIR) + "/" + collection;
    String path = dir + "/" + id + ".json";
    int method = request->method();

    if (id.isEmpty()) {
        if (method != HTTP_GET) {
            sendError(request, 405, "Only GET is allowed on a collection.");
            return;
        }
        JsonDocument doc;
        doc["ok"] = true;
        JsonArray ids = doc["ids"].to<JsonArray>();
        File d = fs->open(dir, "r");
        if (d && d.isDirectory()) {
            File f = d.openNextFile();
            while (f) {
                String name = f.name();
                int s = name.lastIndexOf('/');
                if (s >= 0)
                    name = name.substring(s + 1);
                if (!f.isDirectory() && name.endsWith(".json"))
                    ids.add(name.substring(0, name.length() - 5));
                f.close();
                f = d.openNextFile();
            }
        }
        sendJson(request, 200, doc);
        return;
    }

    if (method == HTTP_GET) {
        if (!fs->exists(path)) {
            sendError(request, 404, "Not found.");
            return;
        }
        request->send(*fs, path, "application/json");
    } else if (method == HTTP_POST || method == HTTP_PUT) {
        JsonDocument check;
        if (deserializeJson(check, body) != DeserializationError::Ok) {
            sendError(request, 400, "Body is not valid JSON.");
            return;
        }
        if (!ensureDir(*fs, dir)) {
            sendError(request, 500, "Could not create the folder on the SD card.");
            return;
        }
        String tmp = path + ".tmp";
        File f = fs->open(tmp, "w");
        if (!f) {
            sendError(request, 500, "Could not write to the SD card.");
            return;
        }
        size_t written = f.write(reinterpret_cast<const uint8_t *>(body.data()), body.size());
        f.close();
        if (written != body.size()) {
            fs->remove(tmp);
            sendError(request, 500, "Writing to the SD card was incomplete.");
            return;
        }
        if (fs->exists(path))
            fs->remove(path);
        if (!fs->rename(tmp.c_str(), path.c_str())) {
            sendError(request, 500, "Could not finish saving the record.");
            return;
        }
        request->send(200, "application/json", "{\"ok\":true}");
    } else if (method == HTTP_DELETE) {
        if (fs->exists(path))
            fs->remove(path);
        request->send(200, "application/json", "{\"ok\":true}");
    } else {
        sendError(request, 405, "Method not allowed.");
    }
}
