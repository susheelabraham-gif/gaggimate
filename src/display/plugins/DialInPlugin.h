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

#define DIALIN_PLUGIN_VERSION "0.3.0"
// GaggiMate 1.10 added ratio targets and a profile dose.
#define DIALIN_HAS_RATIO_TARGET 1

class DialInPlugin : public Plugin {
  public:
    void setup(Controller *controller, PluginManager *pluginManager) override;
    void loop() override {}

    // Called by WebUIPlugin::setupServer() before its catch-all handler.
    void attachRoutes(AsyncWebServer &server);

    // True while a shot from a coffee being dialed in has no tasting feedback yet.
    bool isFeedbackPending() const { return pendingShotId >= 0; }

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
    void handleState(AsyncWebServerRequest *request);
    void handleFeedback(AsyncWebServerRequest *request, const std::string &body);
    void onShotSaved(int shotId);
    String dialingBeanFor(const String &profileId, const String &profileLabel);
    void loadState();
    void saveState();
    void serveIndex(AsyncWebServerRequest *request);

    Controller *controller = nullptr;
    PluginManager *pluginManager = nullptr;
    dialin::SafetyLimits limits{};
    int pendingShotId = -1;
    String pendingBean;
};

extern DialInPlugin DialIn;

#endif // DIALINPLUGIN_H
