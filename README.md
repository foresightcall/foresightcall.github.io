# Pitchcall: free football predictions site

A mobile-friendly website with Premier League, La Liga and Champions League fixtures, Home / Draw / Away percentages from a rating model, and a pick-and-points game for your visitors. Everything runs on free services.

The name "Pitchcall" is a placeholder. Change `siteName` in `config.js`.

## What is in the folder

| Path | What it is |
| --- | --- |
| `index.html`, `assets/`, `config.js` | The website |
| `data/predictions.json` | What the website shows. Right now it holds **demo data** (made-up fixtures) |
| `scripts/update_predictions.py` | Downloads results, updates ratings, writes `predictions.json` |
| `.github/workflows/update.yml` | Runs that script for you every 3 hours |
| `supabase/schema.sql` | The database for sign-in, picks, points and the leaderboard |

## Set up (about 30 minutes, no cost)

### 1. Put the site on GitHub Pages
1. Create a free account at github.com and make a new **public** repository.
2. Upload everything in this folder to it.
3. In the repository, open **Settings > Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
4. After a minute your site is live at `https://YOUR-NAME.github.io/REPOSITORY-NAME/`.

At this point the site works in **demo mode**: the demo data is shown and picks are saved only in each visitor's own browser.

### 2. Switch on real data
1. Register for a free key at <https://www.football-data.org/client/register>. The key arrives by email.
2. In your repository open **Settings > Secrets and variables > Actions > New repository secret**. Name it `FOOTBALL_DATA_TOKEN` and paste the key.
3. Open the **Actions** tab, choose **Update predictions**, and press **Run workflow**.
4. When the run finishes (about a minute) the demo data is replaced with real fixtures and predictions. From then on it refreshes every 3 hours by itself.

If the run shows a red cross, open it and read the log. The most common cause is a mistyped key.

### 3. Switch on sign-in, picks and the leaderboard (optional)
1. Create a free project at <https://supabase.com>.
2. Open **SQL Editor**, paste the whole of `supabase/schema.sql`, and press **Run**.
3. Open **Project Settings > API**. Copy the **Project URL** and the **anon public** key into `config.js` (`supabaseUrl` and `supabaseAnonKey`). The anon key is meant to be public.
4. In **Authentication > URL Configuration**, set **Site URL** to your GitHub Pages address so the emails Supabase sends (confirm your account, reset your password) bring people back to your site. Also add the same address under **Redirect URLs**.
5. In **Authentication > Providers**, make sure **Email** is on. If you leave **Confirm email** on, new people must tap a link in their inbox before they can sign in. Turn it off for faster sign-up, though anyone can then register with an email they don't own.
6. Add two more repository secrets, `SUPABASE_URL` (the Project URL) and `SUPABASE_SERVICE_KEY` (the **service_role** key from the same API page). **Never put the service_role key in any file.** It can change anything in your database. It belongs only in the secrets list.
7. Run the **Update predictions** workflow again. It now also sends the matches to the database.

Points are then awarded automatically each time a finished match is synced.

## How the rules work

- **Model.** Every team has an Elo rating, built from results since three seasons ago (football-data.co.uk) plus this season (football-data.org). The gap between two ratings, plus home advantage, becomes the Home / Draw / Away percentages.
- **Hit rate.** The page shows how often the model's top pick was right over the last year, next to the rate you would get by always picking the home team. Read that number as the real test. Even good models are right only about half the time in football.
- **Picks lock at kickoff.** The database clock decides, not the visitor's phone. The database also stops anyone from changing points, reading other people's picks, or picking after kickoff.
- **Points.** 3 for a correct pick, plus 2 if the model gave that outcome under 25%. To change these numbers, edit `config.js` and the matching numbers in `supabase/schema.sql`.
- **Levels.** More points unlock more picks per week (3, 4, 5, 7, 10).
- **No money.** Keep it free to play and prize-free. Prizes can turn a prediction game into gambling under local law.

## Things worth knowing

- **Free limits.** football-data.org's free key is for personal and non-commercial use and allows 10 requests a minute. The update job makes 3 calls per run, so it stays well inside that. If you ever earn money from the site, check their terms and plans first.
- **Free tiers can pause.** GitHub stops scheduled workflows in a public repository after about 60 days with no activity, and Supabase can pause a free project that sits idle. Check the **Actions** tab once a month. If a workflow was switched off, press **Enable**.
- **Team names.** The two data sources spell some clubs differently ("Man United" and "Manchester United FC"). The script matches them with a small alias list in `update_predictions.py`. A club that fails to match starts with a default rating, and the run log prints a line starting `WARNING` naming it. Newly promoted clubs can appear there legitimately. For any other club, add a line to `ALIASES` to fix it.
- **Champions League** predictions are rougher than league ones. Teams from different countries rarely play each other, so their ratings are less certain.
- **Not tested live.** The script and site were tested on built-in demo data, and the database rules were tested on a local Postgres. They could not be tested against the real football-data and Supabase servers, so expect to read the first run's log and fix small things, such as a club name that did not match.

## Run it on your own computer

```
python3 scripts/update_predictions.py --sample     # demo data, no internet or key needed
python3 -m http.server 8000                        # then open http://localhost:8000
```

The site must be opened through a server like this. Double-clicking `index.html` will not load the data file.

## Data sources

- Results history: <https://www.football-data.co.uk>
- Fixtures and current results: <https://www.football-data.org>


## Owner view (see how many people play)

The control center is its own page, `owner.html` (for example `https://yourname.github.io/owner.html`). Sign in there with the owner account.
It only shows numbers to the owner. It shows players, new and active players, picks per day,
the most picked matches, and whether the data update is still running. You can also remove a player's name from the leaderboard.

Without a database connection the page just says so. It has no sample numbers.

To become the owner: create your own account on the site (email and password, with a name), then then run this in the Supabase SQL Editor (use your own email):

    insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';

Open `owner.html` and sign in. When you are signed in on the main site, your account window also shows an "Open the control center" button.


## Accounts and comments

- Anyone can read the chances and the comments. To pick winners or write a comment, a visitor creates a free account (name, email, password) or signs in. Forgotten passwords are reset by email.
- Each match card has a Comments button and a Match details button. Both open a panel with two tabs: Overview (chances, table position, recent form, fan votes) and Comments. The leaderboard has a panel too ("See all players").
- Comments: A comment is 280 letters at most, one every 10 seconds, 40 a day per person. Writers need a name. Their email is never shown.
- People can delete their own comments. As owner you can delete any comment, either under the match or in the "Latest comments" list in the Owner view. Removing a player's name also hides their comments.
- Crests: when the live data is on, each club's crest from football-data.org shows in the circle. If a crest is missing, the team's letters show instead.
- Tested on a throwaway database and a stand-in for Supabase, not on a real Supabase project.
