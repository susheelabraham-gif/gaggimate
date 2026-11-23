#ifndef DIALINPLUGIN_H
#define DIALINPLUGIN_H

// Dial-in assistant support on the GaggiMate display.
//
// - Serves the Dial-in web app from the SD card at /dialin/ (files in /dialin/www/).
// - Stores the app's records (beans, batches, grinder, calibrations...) as JSON
//   files under /dialin/data/<collection>/<id>.json.
// - Checks every profile the app wants to save against hard safety limits
//   (dialin/SafetyValidator.h) before handing it to ProfileManager.
//
// It never starts a shot.

#include <ESPAsyncWebServer.h>
#include <FS.h>
#include <display/core/Plugin.h>
#include <display/plugins/dialin/SafetyValidator.h>
#include <string>

class Controller;
class PluginManager;
struct Profile;

#define DIALIN_PLUGIN_VERSION "0.2.1"

class DialInPlugin : public Plugin {
  public:
    void setup(Controller *controller, PluginManager *pluginManager) override;
    void loop() override {}

    // Called by WebUIPlugin::setupServer() before its catch-all handler.
    void attachRoutes(AsyncWebServer &server);

    // Exposed for tests.
    static dialin::ProfileSpec toSpec(const Profile &profile);
    static bool isValidName(const String &name);

  private:
    fs::FS *storage() const; // SD card, or nullptr when none is fitted
    void installApp();
    void loadLimits();
    bool saveLimits();

    void handleStatus(AsyncWebServerRequest *request);
    void handleLimitsGet(AsyncWebServerRequest *request);
    void handleLimitsSet(AsyncWebServerRequest *request, const std::string &body);
    void handleProfileCheck(AsyncWebServerRequest *request, const std::string &body, bool save);
    void handleData(AsyncWebServerRequest *request, const std::string &body);
    void serveIndex(AsyncWebServerRequest *request);

    Controller *controller = nullptr;
    PluginManager *pluginManager = nullptr;
    dialin::SafetyLimits limits{};
};

extern DialInPlugin DialIn;

#endif // DIALINPLUGIN_H
