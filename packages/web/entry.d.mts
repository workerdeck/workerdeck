// Absolute path to the built dashboard (`index.html` + content-hashed assets). Mount it at a
// **domain root** (the build sets no `base`) and serve the gateway on the **same origin** under
// `/v1` — a tab cannot header a WS upgrade, so a same-origin cookie is its only credential.
// Routing is hash history: serve `index.html` for every non-asset path, hashed assets
// `immutable`, `index.html` `no-cache`.
export declare const dashboardDir: string

// Absolute path to the entry document inside {@link dashboardDir}.
export declare const dashboardIndexHtml: string
