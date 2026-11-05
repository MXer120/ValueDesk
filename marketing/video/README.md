# ValueDesk launch and feature videos

Code-driven video ([Remotion](https://www.remotion.dev)) cut from real captures of the running app. Every number and
screen in a clip is the app's own; nothing is drawn or mocked up.

```bash
# dependencies, once (251 MB on disk, kept out of the repo and out of OneDrive)
mkdir -p ~/vd-video-deps && cp marketing/video/package.json ~/vd-video-deps/ && (cd ~/vd-video-deps && npm install --no-audit --no-fund --maxsockets 1)
cmd //c mklink /J "marketing\\video\\node_modules" "%USERPROFILE%\\vd-video-deps\\node_modules"

# real footage: the dev web and API running (.claude/launch.json valuescan-web, valuescan-server)
node marketing/video/capture/record.mjs heatmap

# a clip and a graphic, into marketing/video/out/
cd marketing/video
npx remotion render src/index.ts heatmap-clip out/heatmap-clip.mp4 --browser-executable "C:/Program Files/Google/Chrome/Application/chrome.exe"
npx remotion still src/index.ts heatmap-card out/heatmap-card.png --browser-executable "C:/Program Files/Google/Chrome/Application/chrome.exe"
```

`npx remotion studio src/index.ts` opens the timeline for tuning. `public/footage`, `public/stills` and `out` are
gitignored: re-capture them. A new feature clip is a new shot in `capture/record.mjs` and a new `<FeatureClip>` entry in
`src/Root.tsx`: title, line, footage, and the camera moves.

Remotion's license: free for individuals and companies of up to 3 people; $25 per seat per month for 4 or more.
