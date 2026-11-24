# Swift Technologies site

A dependency-free static site for `swift-tech.surge.sh`. No framework, CDN, external fonts, or build step — just `index.html`, `styles.css`, `app.js`, and `favicon.svg`.

## Local preview

```bash
cd swift-tech
python3 -m http.server 8080
```

Then open <http://localhost:8080>. Stop the server with `Ctrl+C`.

## Deploy to Surge

Log in once with `npx surge login`, then publish from this directory:

```bash
cd swift-tech
npx surge ./ swift-tech.surge.sh
```

`CNAME` pins the domain and `.surgeignore` keeps this README out of the published files.

## Notes

- Edition `swift://` routes are planned identifiers, not published installers. Only the stable build links to GitHub releases.
- Counters and the WebGL hero are illustrative; all motion respects `prefers-reduced-motion`.
- Swift Mail is coming soon — waiting on a custom domain for `@swift.email` addresses.
