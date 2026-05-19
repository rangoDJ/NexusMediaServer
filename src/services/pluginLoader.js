/**
 * pluginLoader.js — backward-compatibility shim.
 *
 * All logic now lives in pluginManager.js.
 * Existing imports of { registry, callHook, loadPlugins, updatePluginSettings }
 * continue to work without changes.
 */
export {
  registry,
  callHook,
  loadPlugins,
  updatePluginSettings,
} from './pluginManager.js'
