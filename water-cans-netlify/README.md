# Hostel Water Cans — Netlify version

This folder is the complete website for Netlify's free plan:

- `public/index.html`: the website people see
- `netlify/functions/api.mjs`: the backend (logins, orders, prices, users, CSV download)
- **Netlify Blobs**: Netlify's built-in storage, used as the database. No sign-up or setup needed.

Your current data (users, orders, hostel name, price) is in `netlify/functions/seed-data.mjs`. It is imported automatically the first time the site runs.

## Deploy through GitHub (about 10 minutes)

The backend needs Netlify to install one package (`@netlify/blobs`) when it builds the site. Deploying from GitHub makes Netlify do that automatically.

> Plain drag-and-drop of a folder onto Netlify may publish only the pages, without the backend. Use the GitHub method below.

### 1. Put the files on GitHub
1. Sign in at github.com (free account) and click **New repository**.
2. Name it, for example `water-cans`, choose **Private**, and click **Create repository**.
3. Click **uploading an existing file**.
4. Unzip this download on your computer. Open the `water-cans-netlify` folder and drag **everything inside it** into the GitHub page: `public`, `netlify`, `netlify.toml`, `package.json`, `README.md`.
5. Click **Commit changes**.

Check that GitHub shows `netlify.toml` and `package.json` at the top level of the repository, not inside another folder.

### 2. Connect it to Netlify
1. Sign in at app.netlify.com.
2. Click **Add new project → Import an existing project → GitHub**, and allow Netlify to see your repository.
3. Pick the `water-cans` repository.
4. Leave the build settings as they are. They come from `netlify.toml`: publish directory `public`, functions `netlify/functions`, no build command.
5. Click **Deploy**.

After about a minute your site is live at `https://<name>.netlify.app`. You can rename it under **Project configuration → Change project name**.

**Already have a Netlify site you want to reuse?** Open it, go to **Project configuration → Build & deploy → Link repository**, and choose the GitHub repository.

### 3. Log in
- **Admin:** username `admin` with your current admin password. Change it from the admin panel straight away.
- **Members** keep their current usernames and passwords.

Old passwords are upgraded to secure storage the first time each person logs in.

## Making changes later
Edit a file on GitHub (or upload a new version) and commit. Netlify rebuilds the site automatically. Your data stays in Netlify Blobs and is not affected by new deploys.

## Settings
At the top of `netlify/functions/api.mjs`:

| Setting | Default | What it does |
|---|---|---|
| `TIME_ZONE` | `Asia/Karachi` | Months and days are counted in this time zone |
| `SHOW_NAMES_ON_LOGIN` | `true` | Show name buttons on the login screen |
| `MAX_LOGIN_FAILS` | `8` | Wrong passwords allowed per connection in 10 minutes |
| `SESSION_DAYS` | `60` | How long people stay logged in |

## How the data is stored (Netlify Blobs, store name `water-cans`)

| Key | Contents |
|---|---|
| `settings` | Hostel name, currency, price per can |
| `users` | Every account: username, name, role (admin or member), secure password hash |
| `o/<YYYY-MM>/<order>` | One entry per order: who, how many cans, the price at that time, when |
| `attempts/<id>` | Wrong-password counters |
| `meta/secret`, `meta/imported` | Login-cookie signing key (made automatically) and the import marker |

You can browse this data in Netlify under **Project → Blobs**.

## Security
- Passwords are stored with scrypt hashing, never in plain text.
- The server checks every action. Members can only add cans; everything else needs the admin account.
- Login cookies are signed, HTTP-only and HTTPS-only, so they can't be faked or read by scripts.
- Too many wrong passwords from one connection locks login for 10 minutes.
- Requests from other websites are refused.

## Backups
As admin, download each month's list as CSV from the Monthly list page.

## Troubleshooting
- **Pages load but login says "The server didn't answer properly"**: the backend wasn't deployed. Check that `netlify.toml` and `package.json` are at the top level of the GitHub repository, then redeploy. In Netlify, **Logs → Functions** should list `api`.
- **"The storage isn't available yet"**: wait a minute after the first deploy and refresh.
