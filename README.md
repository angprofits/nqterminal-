# NQ Terminal - deployment guide (GitHub + Render, no coding)

## A. Put the files on GitHub
1. Unzip nq-terminal.zip. You get: server.js, index.html, package.json, render.yaml, test.js, README.md.
2. Go to github.com, sign in, click "+" (top right) > New repository. Name it nq-terminal, choose Public or Private, click Create repository.
3. Click "uploading an existing file". Drag ALL the unzipped files in (not the folder itself). Click Commit changes.

## B. Deploy on Render
1. render.com > sign in with GitHub > New + > Web Service > pick your nq-terminal repo > Connect.
2. Use exactly:
   - Name: nq-terminal | Language: Node | Branch: main | Region: any
   - Build Command: npm install
   - Start Command: npm start
   - Instance Type: Free
3. Advanced > Health Check Path: /healthz
4. Environment Variables (Advanced > Add Environment Variable):
   - NODE_VERSION = 22          (REQUIRED)
   - FINNHUB_KEY = <free key>   (optional: real-time trade stream, get one free at finnhub.io)
   - SEC_CONTACT = you@email.com (optional: polite identification for SEC.gov)
   - MEGA_WEIGHTS = NVDA:7.7,GOOGL:6.4,MU:5.2,MSFT:4.9,AMZN:4.2 (optional: refresh Nasdaq-100 weights, % each; check invesco.com/qqq)
   - MEGA_SYMBOLS = NVDA,GOOGL,MU,MSFT,AMZN (optional: change the mega-cap group; must be among the 19 watchlist tickers)
   - SPCX_WEIGHT = 1.2 (optional: SpaceX weight in %)
   - Do NOT set ACCESS_TOKEN: leaving it unset keeps the site public.
5. Click Create Web Service. After the build, open the https://nq-terminal-xxxx.onrender.com address.
Keys live only in Render's settings; they are never in the code or sent to the browser.

## C. Check it works
The top bar shows one pill per feed: Yahoo quotes, News RSS, Official, Push. Green = OK. An error shows its exact text.
Free Render services sleep after ~15 min idle: first load then takes ~1 minute.
API: /api/mega /api/spacex /api/status /api/quotes /api/quotes/NVDA /api/sync /api/signals /api/news /api/config


## Updating an existing deployment
On GitHub open your repo > Add file > Upload files > drag in the new server.js, index.html, test.js, README.md > Commit. Render redeploys automatically (about 2 minutes).

## New in this version
- Watchlist: SPCX, NVDA, PLTR, INTC, JPM, GOOGL, GOOG, AMD, MU, AMZN, MSFT, META, TSLA. Add tickers in the watchlist box (Enter), remove with the x on a row. Saved on the server in watch.json (set DATA_DIR to a persistent disk if you have one; Render free storage resets).
- Gold, crude, 10Y yield, dollar, VIX and SMH shown with their correlation to NQ.
- Layout button (top left): show/hide, resize and reorder panels; every panel header also has -, + and x. Saved in your browser.

## Everything else (this version)
- Signal journal (what NQ did 1/5/15 min after each alert, with hit rates), calendar panel (options expiry, quarterly rebalance/NQ expiry, jobs report, FOMC; add your own, e.g. `2026-10-28 16:05 | EARN:MSFT` in ET: an EARN: event removes that stock from the alignment group for the surrounding day), time-of-day and event-window rules (higher confirmation threshold), lead/lag vs NQ, NQ roll guard, early-close days, rate limiting, feed-down alert, keep-alive ping.
- Optional environment variables: NTFY_TOPIC (phone push via the free ntfy app), WEIGHTS_URL (JSON or "SYMBOL,weight" lines, refreshed every 12h), CAL_EVENTS (events separated by ;), DATA_DIR (where journal/events/watchlist/ticks are stored), RECORD=0 (turn off price recording), MEGA_SYMBOLS, MEGA_WEIGHTS, SPCX_WEIGHT.
- Replay a recorded day: `node replay.js ticks/t-YYYY-MM-DD.jsonl` (files are written to DATA_DIR/ticks, last 5 days kept).
- Render's free disk is wiped on restart/redeploy, so journal, events, watchlist and recordings reset unless you attach a persistent disk and point DATA_DIR at it.
