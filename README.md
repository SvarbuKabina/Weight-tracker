# Weight Tracker

A small app for tracking body weight and gym lifts. It installs on Android and iPhone from the browser, works offline, and keeps your data on your phone.

**Weight**
- Log a weigh-in in a couple of taps (the last weight is prefilled; use − / + to adjust)
- A chart with 1M / 3M / 6M / 1Y / All ranges; tap it to read any day
- Goal weight with progress and an estimated arrival date at your 4-week pace
- Target pace as a range (e.g. lose 0.5–1.0 kg per week), and a Pace tab comparing how fast your weight changed over the last 7 days to all time, and week by week or month by month, against that range
- Daily reminder as a recurring calendar event (Google Calendar or an .ics file)

**Gym**
- A routine of workouts (e.g. Push, Pull, Legs), each a list of exercises
- Substitutes per exercise (e.g. pec deck for incline bench); pick which one you did when logging
- Log sets of weight × reps, with last time's sets shown (from the same position in the same workout first) and one tap to repeat them
- Bodyweight exercises (pull-ups, dips…) log added weight only
- Progress per lift: est. 1RM, heaviest set or volume (most reps, total reps or added weight for bodyweight lifts)
- History follows the lift by name across workouts, and can be split by position (e.g. incline bench as Upper 2 #1 vs as the substitute in Upper 1 #3), optionally with whatever else you did in that position

**Everywhere**
- Full backup and restore (one .json file), plus CSV exports of weigh-ins and workouts for spreadsheets
- kg or lb, light and dark mode

## Files

| File | What it is |
|---|---|
| `index.html` | The page |
| `styles.css` | Look and layout |
| `app.js` | Weight tracking, navigation, settings, backup |
| `gym.js` | Gym routine, workout logging and lift progress |
| `sw.js` | Service worker (offline support and updates) |
| `manifest.webmanifest` | Makes it installable (name, icons, colours) |
| `icons/` | App icons |

`.claude/` holds a local test server and is not part of the app.

## Put it online with GitHub Pages (free)

The app has to be served over HTTPS before a phone can install it.

1. Create a free account at github.com.
2. Create a new **public** repository named `weight-tracker`.
3. Click **Add file → Upload files** and drag in `index.html`, `styles.css`, `app.js`, `gym.js`, `sw.js`, `manifest.webmanifest` and the `icons` folder. Click **Commit changes**.
4. Open **Settings → Pages**. Under "Branch" pick `main` and `/ (root)`, then **Save**.
5. After a minute the app is live at `https://<your-username>.github.io/weight-tracker/`.

The code is public, but your data is not: it never leaves your phone.

## Install on your phone

- **Android (Chrome):** open the link, then tap **Install app** under Settings in the app, or use the ⋮ menu → **Install app**.
- **iPhone (Safari):** open the link, tap **Share → Add to Home Screen**. Install it *before* you restore a backup, because the Home Screen app keeps its own data, separate from Safari.

## Moving to a new phone

On the old phone: Settings → Backup → **Download backup** (or **Share backup**), and get the file to the new phone (email, Google Drive, etc.).
On the new phone: install the app, then Settings → Backup → **Restore or import** and pick the file.

## Updating the app

Upload the changed files to the same GitHub repository. The next time the app opens with internet, it loads the new version. Your data isn't touched. Bump `APP_VERSION` in `app.js` so you can see which version you're running (Settings → About). If you add a new file, also add it to `ASSETS` in `sw.js` and bump `CACHE` there.
