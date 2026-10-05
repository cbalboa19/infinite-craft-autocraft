# Infinite Craft Auto-Craft

A single-file browser script that plays [Infinite Craft](https://neal.fun/infinite-craft/) for you and tries to find as many **new elements** and **🏆 first discoveries** as possible.

It runs inside the game page, uses the game's own engine (so everything lands in your normal save), and learns as it goes which combinations are worth trying.

## Quick start

1. Open <https://neal.fun/infinite-craft/>.
2. Open the browser console: **F12** (or **Ctrl+Shift+J** / **Cmd+Option+J**) → **Console**.
3. Copy the whole of [`autocraft.js`](autocraft.js), paste it into the console and press **Enter**.
   - Chrome may ask you to type `allow pasting` first. That is a normal browser safety check.
4. A panel appears in the top-left corner and crafting starts.

To update or restart, paste the script again: it replaces the running copy and keeps everything it has learned. To stop it, press **✕** on the panel.

## Why it works the way it does

The game's server limits how many requests you can make per second. Go over that limit and Cloudflare blocks your IP for a while. A faster computer does not help: choosing a pair takes microseconds, and the waiting is all on the network.

The limit is lower than you might expect. In testing, after several hundred combinations at 1.5–2 per second spread over about an hour, the server returned HTTP 429 and asked for a wait of about 30 minutes. The default pace is therefore 2 per second. If you get blocked often, lower it to 1–1.5.

So the only way to get more out of it is to **make every request count**. Auto-Craft never repeats a combination, and it chooses each new one with a model that predicts how likely it is to produce something new.

## Features

### 🧠 A learning model picks every pair

- Every turn, seven strategies propose about 140 untried pairs between them:

  | Strategy | Proposes |
  | --- | --- |
  | basic | a promising element + Water / Fire / Wind / Earth |
  | fresh | two promising elements |
  | mixed | a promising element + any element |
  | recent | one of your latest discoveries + something |
  | double | an element with itself (X + X) |
  | rare | your 🏆 first discoveries with each other |
  | target | elements whose names resemble your search target |

- An **online logistic regression** scores every candidate. It uses 17 features, including each element's track record, how often it returns "Nothing", its generation (how many crafts deep it is), how recently it was found, name length, words shared between the two names, and how many 🏆 it has produced.
- One pair is chosen with **Boltzmann exploration**: usually one of the best, sometimes a riskier one so the model keeps learning. 4% of picks are uniformly random.
- The model has **two heads**: one predicts "new element" and the other "🏆 first discovery". You choose which one to optimise for.
- After each server response the weights are updated, and they are saved between sessions.
- The panel shows what the model **predicts versus what actually happens**, so you can see whether it is well calibrated.

### 🔎 Search for an element

Type a word such as `Dragon` and press Enter. The search leans towards elements with similar names (letter-trigram similarity) and stops when the target appears. If you already own it, the panel shows you its recipe instead.

This is a heuristic. The game gives no way to know a result before asking for it, so there is no guaranteed path to a given element.

### Never wastes a request

- Reads your full recipe history, so a known pair is never tried again.
- Remembers pairs that returned "Nothing" (the game itself does not store them). They are kept in **IndexedDB**, so there is no 5 MB `localStorage` limit, and they are migrated automatically from older versions.
- Tells real "Nothing" results apart from server errors by reading the API response, so a failed request is retried rather than written off.

### Plays nicely with the rate limit

- Fixed, adjustable pace from 1 to 5 combinations per second (default 2), with up to 6 requests in flight.
- **AIMD pacing.** After a block it stops, waits (1, 2, 4… up to 15 minutes, or whatever `Retry-After` says) and drops its speed cap to 70%. It then raises the cap by 0.5/s for every 20 minutes without a block.
- Exponential backoff on server errors (3 s, 6 s, 12 s… up to 1 minute).
- **One tab at a time.** A Web Locks mutex stops two tabs from crafting at once and doubling your rate. A second tab waits and takes over if the first one closes.
- **Keeps going in a background tab.** Its timers run in a Web Worker, because Chrome slows ordinary timers in hidden tabs to once a minute.

### Panel

- Live stats: new elements, 🏆 first discoveries, combinations, hit rate, combos per minute and active time.
- Chart of new elements per minute over the last 30 minutes, with 🏆 in gold.
- Speed slider, goal selector (✨ new or 🏆 first discoveries) and auto-stop after a time, a number of new elements or a number of 🏆.
- Per-strategy hit rates and how often the model picks each strategy.
- Searchable log with the model's predicted probability next to every result.
- Sound and a tab-title badge when you get a 🏆.
- **Export 🏆** downloads a `.txt` with all your first discoveries and their recipes.
- Draggable and collapsible, follows the game's dark mode, and remembers its position and settings.
- Shortcuts: **Alt+P** pauses or resumes, **Alt+M** collapses the panel.

## Console API

Once it is running, `window.autoCraft` exposes:

```js
autoCraft.pause();
autoCraft.resume();
autoCraft.setPace(4);                 // combinations per second (1–5)
autoCraft.setGoal('first');           // 'new' or 'first'
autoCraft.setTarget('Dragon');        // '' to clear
autoCraft.stopAfter({ minutes: 30 }); // or { items: 100 } / { firsts: 5 }
autoCraft.exportFirsts();
autoCraft.stats();                    // session, all-time, pace, model weights…
autoCraft.resetLearning();            // forget the model and strategy stats
autoCraft.resetPaceCap();             // forget the speed cap learned from blocks
autoCraft.forgetNothing();            // forget remembered "Nothing" pairs
autoCraft.destroy();                  // stop and remove everything
```

## What it stores

Everything stays in your browser, on the neal.fun site:

| Where | What |
| --- | --- |
| `localStorage` | settings, panel position, speed cap, model weights, strategy stats and all-time totals |
| IndexedDB (`autocraft`) | pairs that returned "Nothing", per save slot |

It sends nothing anywhere. The only network requests are the game's own crafting requests.

## Limitations

- The hit rate can never reach 100%, and it falls as your collection grows: most combinations of common elements are already known.
- The model's advantage is modest at first and improves over a few hundred combinations.
- It relies on the game's internals (`window.IC` and the main Vue component). If neal.fun changes them, the script may need updating. It falls back to `IC.craft` when it cannot find the component.

## Disclaimer

This is an unofficial fan project and is not affiliated with neal.fun. Please keep the pace reasonable: the defaults are deliberately conservative to respect the game's servers. Use it at your own risk.

## License

[MIT](LICENSE)
