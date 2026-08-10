// The call around the panel: a browser window, camera-off participant tiles, and a shared screen.
//
// The tiles are camera-off tiles - the initial-in-a-circle that Meet itself renders when nobody has their
// camera on, which is what most working calls actually look like. No invented faces, no stock people, no
// Google or Meet branding: the call area is deliberately generic and only the address bar names the product.
// Set MLA_FACE=/path/to/photo.jpg to drop a real photo into the "You" tile.
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

export const W = 1440, H = 900, PANEL_W = 400, BAR_H = 44;

const face = process.env.MLA_FACE && existsSync(process.env.MLA_FACE)
  ? `data:image/${path.extname(process.env.MLA_FACE).slice(1)};base64,` + readFileSync(process.env.MLA_FACE).toString('base64')
  : null;

export const PEOPLE = [
  { name: 'Dana K.', initial: 'D', tint: '#8a6bd1' },
  { name: 'Marc T.', initial: 'M', tint: '#2f7d6b' },
  { name: 'You', initial: 'Y', tint: '#3f5fbf', self: true },
];

export const shell = (stage, panel, { w = W, h = H, title = 'Release review', url = 'meet.google.com/qtr-8f2k-nvd' } = {}) => `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${w}px; height: ${h}px; overflow: hidden; background: #e7e9f2;
    font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #14162a; }
  .win { width: ${w}px; height: ${h}px; display: flex; flex-direction: column; background: #f2f3f8; }
  .bar { height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 14px; background: #dfe1ec; flex: 0 0 auto; }
  .dots { display: flex; gap: 7px; }
  .dots i { width: 11px; height: 11px; border-radius: 50%; display: block; }
  .tab { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 16px; margin-left: 8px;
    background: #f7f8fc; border-radius: 9px 9px 0 0; font-size: 12.5px; color: #3c4160; }
  .tab .fav { width: 12px; height: 12px; border-radius: 3px; background: linear-gradient(135deg, #4f7cff, #6f4ff0); }
  .url { flex: 1; height: 28px; margin-left: 12px; border-radius: 14px; background: #f7f8fc;
    display: flex; align-items: center; padding: 0 14px; font-size: 12.5px; color: #6a6f8c; }
  .body { flex: 1; display: flex; min-height: 0; }
  .call { flex: 1; background: #191b22; padding: 22px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .grid { flex: 1; display: grid; gap: 16px; min-height: 0; }
  .grid.three { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
  .grid.three .tile.self { grid-column: 1 / -1; }
  .tile { position: relative; border-radius: 16px; background: #24262f; display: grid; place-items: center; overflow: hidden;
    border: 3px solid transparent; }
  .tile.speaking { border-color: #6f8cff; box-shadow: 0 0 0 6px rgba(111, 140, 255, .16); }
  .tile .av { width: 108px; height: 108px; border-radius: 50%; display: grid; place-items: center;
    color: #fff; font-size: 42px; font-weight: 600; letter-spacing: .01em; }
  .tile img.av { object-fit: cover; }
  .tile .who { position: absolute; left: 16px; bottom: 14px; display: flex; align-items: center; gap: 8px;
    color: #eceef7; font-size: 14px; font-weight: 500; text-shadow: 0 1px 3px rgba(0,0,0,.5); }
  .bars { display: flex; align-items: flex-end; gap: 2.5px; height: 15px; }
  .bars i { width: 3px; border-radius: 2px; background: #7ee0a8; display: block; }
  .muted { width: 15px; height: 15px; border-radius: 50%; background: #d1495b; display: inline-block; }
  .share { flex: 3; border-radius: 16px; background: #f7f8fc; overflow: hidden; display: flex; flex-direction: column;
    border: 3px solid #6f8cff; box-shadow: 0 0 0 6px rgba(111, 140, 255, .16); }
  .share .head { padding: 14px 24px; font-size: 15px; color: #6a6f8c; background: #eceef7; }
  .strip { flex: 0 0 128px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .strip .tile .av { width: 54px; height: 54px; font-size: 21px; }
  .strip .tile .who { font-size: 12px; left: 12px; bottom: 10px; }
  .work { flex: 1; border-radius: 16px; background: #14161d; overflow: hidden; display: flex; flex-direction: column;
    border: 1px solid #2a2d38; font: 15px/1.75 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .work .head { padding: 12px 20px; font-size: 13px; color: #8b90a8; background: #1c1f28;
    font-family: -apple-system, system-ui, sans-serif; }
  .work .out { padding: 20px 26px; color: #c6cadb; }
  .work .out .dim { color: #6c7285; }
  .work .out .err { color: #ff7b7b; }
  .cal { flex: 1; padding: 30px 44px; display: flex; flex-direction: column; justify-content: center; }
  .cal h3 { font-size: 28px; margin-bottom: 6px; }
  .cal p { color: #6a6f8c; font-size: 16px; margin-bottom: 30px; }
  .days { display: grid; grid-template-columns: repeat(8, 1fr); gap: 12px; }
  .day { height: 118px; border-radius: 12px; background: #eceef7; padding: 14px 14px; font-size: 15px; color: #6a6f8c; }
  .day.freeze { background: #fde8ea; color: #b3243a; }
  .day.pick { background: #fff; border: 2px solid #d1495b; color: #b3243a; font-weight: 700; }
  .day b { display: block; font-size: 22px; margin-bottom: 4px; color: inherit; }
  .legend { margin-top: 26px; font-size: 16px; color: #b3243a; }
  img.panel { width: ${PANEL_W}px; flex: 0 0 ${PANEL_W}px; height: 100%; display: block; border-left: 1px solid #d7dae8; }
</style>
<div class="win">
  <div class="bar">
    <div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
    <div class="tab"><span class="fav"></span>${title}</div>
    <div class="url">${url}</div>
  </div>
  <div class="body">
    <div class="call">${stage}</div>
    <img class="panel" src="data:image/png;base64,${panel}" />
  </div>
</div>`;

const bars = (heights) => `<span class="bars">${heights.map((h) => `<i style="height:${h}px"></i>`).join('')}</span>`;

const tile = (p, speaking) => `<div class="tile${speaking ? ' speaking' : ''}${p.self ? ' self' : ''}">
  ${p.self && face ? `<img class="av" src="${face}" />` : `<span class="av" style="background:${p.tint}">${p.initial}</span>`}
  <span class="who">${p.name}${speaking ? bars([5, 11, 15, 8, 4]) : '<span class="muted"></span>'}</span>
</div>`;

export const gridStage = (speakerName) => `<div class="grid three">
  ${PEOPLE.map((p) => tile(p, p.name === speakerName)).join('')}
</div>`;

export const shareStage = (speakerName) => `
<div class="share">
  <div class="head">Marc T. is presenting - Release calendar, August</div>
  <div class="cal">
    <h3>August release calendar</h3>
    <p>Customer-facing releases only</p>
    <div class="days">
      ${[11, 12].map((d) => `<div class="day"><b>${d}</b></div>`).join('')}
      ${[13, 14].map((d) => `<div class="day freeze"><b>${d}</b>freeze</div>`).join('')}
      <div class="day pick"><b>15</b>promised</div>
      ${[16, 17].map((d) => `<div class="day freeze"><b>${d}</b>freeze</div>`).join('')}
      <div class="day"><b>18</b></div>
    </div>
    <p class="legend">Freeze window 13-17 Aug, agreed 22 July</p>
  </div>
</div>
<div class="strip">${PEOPLE.map((p) => tile(p, p.name === speakerName)).join('')}</div>`;

// Co-pilot mode has no meeting at all: the assistant watches the tab you are working in. So the stage is that
// tab, not a call - showing a participant grid here would be a lie about what the mode is.
export const workStage = () => `<div class="work">
  <div class="head">Terminal - migrate.ts</div>
  <div class="out">
    <div class="dim">$ node scripts/migrate.ts --batch 2</div>
    <div>reading billing_events ...</div>
    <div class="dim">batch 1/4  ok      41,208 rows   3.1s</div>
    <div class="err">batch 2/4  timeout after 120s</div>
    <div class="dim">  at readBatch (migrate.ts:88)</div>
    <div class="dim">  at main (migrate.ts:214)</div>
    <div>&nbsp;</div>
    <div class="dim">$ </div>
  </div>
</div>`;

