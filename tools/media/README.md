# Landing-page media

Everything in `docs/media/` is generated from these scripts. They open the **real** `src/sidepanel.html` in a
headless browser and fill it with a meeting that never happened, so the interface on the marketing page is
always the shipping one and no real person's words are published.

Re-run them whenever the panel's markup or styling changes - otherwise the screenshots quietly start
advertising a UI that no longer exists.

```sh
npm i -D playwright && npx playwright install chromium   # not a project dependency
node tools/media/stage.mjs     # docs/media/call-share.png, copilot.png + the three store tiles
node tools/media/call-clip.mjs # docs/media/{call,planning}-live.{mp4,gif} + posters  (needs ffmpeg)
node tools/media/og-card.mjs   # docs/media/og-card.png  (reads call-share.png, run it last)
node tools/media/promo-tile.mjs # docs/media/store-promo-440x280.png  (the store will not accept a submission without it)
```

`panel.mjs` holds the shared writers and the three scripted sessions (a release review, a sprint
planning call with autopilot on, a co-pilot debug);
`call-shell.mjs` holds the browser window, the participant tiles and the shared screen. A wording change in
either lands in every image at once.

**Never the panel on its own.** A screenshot of the side panel with nothing around it shows a list of
coloured cards reacting to nothing. Every image here keeps the thing it is reacting to in frame: the call, the
shared screen, or the tab in co-pilot mode.

**No invented people.** The participant tiles are camera-off tiles - the initial-in-a-circle every call app
falls back to, which is what most working calls look like anyway. There is no stock photography, no
generated face and no Google or Meet branding; only the address bar names the product. Set
`MLA_FACE=/path/to/photo.jpg` to drop a real photo into the "You" tile.

Already have Playwright somewhere else: `MLA_PLAYWRIGHT=/path/to/playwright/index.mjs node tools/media/stage.mjs`.

The two scenes are chosen, not decorative. The release review is the shortest scene in which catching
something *before* it becomes a promise is visible. The planning call is the only way to show the half that
prose keeps failing to sell: with autopilot on the assistant checks a claim against the tracker, files the
ticket and drafts the note itself, and nobody typed anything. Keep both if you edit the scripts.

Everything the planning scene shows is behaviour the skill actually specifies (`create` ON = standing
authorization to create, echo `🟠 ACTION → what I created`; `postChat` ON = share the link with the room).
If that contract changes, change the scene, or the page starts promising something the product stopped doing.
