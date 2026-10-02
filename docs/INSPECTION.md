# Milestone 1 — inspecting a real Whatnot auction

Goal: find where Whatnot's auction state comes from (WebSocket, GraphQL response,
React props, or DOM) without guessing. Do the steps below on a real stream and send
back the results.

## A. Extension capture (easiest, most useful)

1. Reload the extension, then open a livestream and refresh the tab. The side panel's
   Debug section should show **Page hook: ready**. The Stream row should show an ID; if
   it says "not on a livestream page", send me the tab's URL.
2. Leave **recording** on. While an auction runs, press **Mark** with a label at each
   key moment:
   - `item start` when a new item/auction appears
   - `bid seen £X` when someone bids (type the amount)
   - `ending` in the last few seconds
   - `ended / sold`
   - `sudden death item` when the skull is shown
3. Try to cover at least one **normal** auction, including one where a late bid
   extends the timer, and one **Sudden Death** auction.
4. While an auction is live:
   - **Find value**: type the current price exactly as shown (e.g. `£18`). The results
     show which message/path carries it. Do the same for the item name.
   - **Field discovery** → Refresh. Look for paths whose `Δ` (changes) increases with
     bids, and fields like `endsAt`, `endTime`, `suddenDeath`.
5. **Pick element**, then click the price, then the timer, then the skull icon, then the bid
   button. The click is swallowed and does **not** reach Whatnot. After each pick, press
   **Copy result** and save the JSON. The React findings are the important part.
6. **Globals probe** once → Copy result.
7. **Export capture (.json)** after the auction finishes. Send me the file.

> The export contains what your browser received on the page: chat messages and
> possibly your username or tokens in request bodies. Skim it or redact before sharing.

## B. Chrome DevTools (to confirm or fill gaps)

Open DevTools (F12) on the stream tab.

1. **Network → WS** (filter "WS"), reload the page. For each socket, send:
   - the URL
   - from the **Messages** tab, a few frames received when (a) a bid lands, (b) the
     timer is extended, (c) the auction ends, (d) the next item starts.
     Right-click → Copy message.
   - whether frames are text (JSON) or binary. If binary, the extension exports
     base64 and we'll need to decode it.
2. **Network → Fetch/XHR**, filter `graphql`. Send the request payload (operationName)
   and response for anything returned when a new item starts.
3. **Place one real bid by hand** on something cheap, with Network open and "Preserve log"
   ticked. Send:
   - the request(s) or outgoing WS frame the click produced, which shows how a bid is
     actually executed
   - the confirmation/rejection message that came back
   - Elements → right-click the bid button → Copy → Copy outerHTML

   This is required before we implement the bid executor.
4. **Elements**: right-click the auction/price area → Copy outerHTML (the whole
   auction card), once for a normal auction and once for a Sudden Death one.
5. **Console**: any `[WBA …]` lines that look wrong, especially errors.

## What I will do with it

- Write a source in `content/sources/` that maps the real data to `auctionId`,
  `currentBidMinor`, `nextBidMinor`, `endTime`, `suddenDeath`, `active`/`ended`.
  Structured data comes first, with the DOM (e.g. the skull) as a fallback.
- Use the server timestamps in the messages, if any, to tighten the clock offset beyond
  the ±500 ms that HTTP Date headers give.
- Measure WebSocket-vs-DOM latency from the capture timeline (`p` = performance.now()).
