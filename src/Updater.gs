/**
 * Updater.gs
 * JayaPOS is updated automatically from GitHub (odeliasabrina24-byte/jayapos):
 * every change in src/ is pushed to this Apps Script project and deployed by GitHub Actions (clasp),
 * so the web app link (/exec) stays the same and phones only need to reopen JayaPOS.
 *
 * autoMigrate_(): the first time a new version opens, the database setup runs once by itself
 * (new sheets, columns and settings are added; nothing is deleted).
 */

function autoMigrate_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_VERSION') === APP_VERSION) return false;
  if (!props.getProperty('SPREADSHEET_ID')) return false;    // never set up: the owner runs Setup from the Sheet
  return withLock_(function () {
    if (props.getProperty('SCHEMA_VERSION') === APP_VERSION) return false;
    setupDatabase_();
    return true;
  });
}
