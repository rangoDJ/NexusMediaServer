# Plugin Catalog Format

A catalog source is a URL that serves a JSON file in this format.
Add sources via **Settings → Plugins → Catalog Sources** or:

```
POST /api/v1/plugins/catalog/sources
{ "name": "My Repo", "url": "https://example.com/nexus-plugins/catalog.json" }
```

---

## Catalog JSON schema

```json
{
  "repositoryName": "My Plugin Repository",
  "repositoryUrl":  "https://example.com/nexus-plugins",
  "plugins": [
    {
      "id":          "my-plugin",
      "name":        "My Plugin",
      "description": "Short one-line summary.",
      "overview":    "Longer markdown description shown in the plugin detail view.",
      "author":      "Your Name",
      "category":    "Metadata",
      "imageUrl":    "https://example.com/nexus-plugins/my-plugin.png",
      "versions": [
        {
          "version":          "1.2.0",
          "changelog":        "Added collection support, fixed artwork URLs.",
          "downloadUrl":      "https://example.com/nexus-plugins/my-plugin-1.2.0.js",
          "minServerVersion": "0.1.0",
          "timestamp":        "2025-03-01T00:00:00Z"
        },
        {
          "version":          "1.1.0",
          "changelog":        "Initial release.",
          "downloadUrl":      "https://example.com/nexus-plugins/my-plugin-1.1.0.js",
          "minServerVersion": "0.1.0",
          "timestamp":        "2025-01-15T00:00:00Z"
        }
      ]
    }
  ]
}
```

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `repositoryName` | string | yes | Human-readable repo name shown in the UI |
| `repositoryUrl` | string | no | Homepage for this repository |
| `plugins[].id` | string | yes | Must match `manifest.id` in the plugin file |
| `plugins[].name` | string | yes | Display name |
| `plugins[].description` | string | yes | One-line summary |
| `plugins[].overview` | string | no | Markdown, shown in plugin detail |
| `plugins[].author` | string | no | Author name or GitHub handle |
| `plugins[].category` | string | no | `Metadata` \| `Notifications` \| `Authentication` \| `General` |
| `plugins[].imageUrl` | string | no | Plugin logo/icon URL |
| `plugins[].versions` | array | yes | Descending version order; first entry = latest |
| `versions[].version` | string | yes | Semver (`1.2.0`) |
| `versions[].changelog` | string | no | What changed in this version |
| `versions[].downloadUrl` | string | yes | Direct URL to the `.js` plugin file |
| `versions[].minServerVersion` | string | no | Minimum NexusMediaServer version |
| `versions[].timestamp` | string | no | ISO 8601 release date |

---

## Install flow

When the admin clicks **Install** on a catalog entry:

1. Client calls `POST /api/v1/plugins/install` with `{ downloadUrl, pluginName }` 
   (the `downloadUrl` is `versions[0].downloadUrl` — the latest version).
2. The server downloads the `.js` file with axios (10 MB limit).
3. The file is saved to `PLUGINS_PATH/<pluginName>.js`.
4. The plugin is loaded immediately — no restart required.
5. The plugin's `onLoad` lifecycle function is called.
6. The plugin appears in `GET /api/v1/plugins` with `install_source: "url"`.

---

## Plugin file format

Each `downloadUrl` must point to a single `.js` ES module file.
See `docs/example-plugin/index.js` for the full contract.

> **ZIP support** — directory-style plugins (folder + `index.js`) must be
> installed manually by copying to `PLUGINS_PATH/`. Automatic ZIP download
> and extraction is planned for a future release.
