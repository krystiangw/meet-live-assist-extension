# Landing-page media

Everything in `docs/media/` is generated from these scripts. They open the **real** `src/sidepanel.html` in a
headless browser and fill it with a meeting that never happened, so the interface on the marketing page is
always the shipping one and no real person's words are published.

Re-run them whenever the panel's markup or styling changes - otherwise the screenshots quietly start
advertising a UI that no longer exists.

```sh
npm i -D playwright && npx playwright install chromium   # not a project dependency
node tools/media/still.mjs     # docs/media/panel-full.png
node tools/media/clip.mjs      # docs/media/panel-live.{mp4,gif} + poster  (needs ffmpeg)
node tools/media/store.mjs     # docs/media/store-*.png - the 1280x800 Chrome Web Store tiles
node tools/media/og-card.mjs   # docs/media/og-card.png  (reads panel-full.png, run it last)
```

`panel.mjs` holds the shared filler and the two scripted sessions (a release review, a co-pilot debug) that
every image draws from, so a wording change lands everywhere at once.

The store tiles are a caption beside the live panel, not a photograph of a browser window. That is
deliberate: faking a call grid means inventing faces, and a listing image that invents its own users is the
one thing a reviewer should reject.

Already have Playwright somewhere else: `MLA_PLAYWRIGHT=/path/to/playwright/index.mjs node tools/media/still.mjs`.

The invented call is a release review where a date gets promised that contradicts a freeze. Keep it that way
if you edit the scripts: it is the shortest scene in which the product's actual value is visible.
