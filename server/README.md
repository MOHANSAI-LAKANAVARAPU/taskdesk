# TaskDesk

Task assignment and tracking for managers, team leads and employees.

- **Admins and managers** add people, create projects, assign tasks to anyone, and see every project and employee.
- **Team leads** assign tasks to the people who report to them and see their team’s progress.
- **Employees** see their own tasks, post progress updates, and mark tasks completed.

The dashboard shows tasks assigned, completed, in progress, not started and overdue, for each project and each employee.

## Option 1: Run with Docker (recommended)

1. Copy this folder to your server.
2. Copy `.env.example` to `.env` and set `ADMIN_NAME`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the first admin account (`docker-compose.yml` reads it via `env_file`; `.env` is not committed).
3. Start it:
   ```bash
   docker compose up -d --build
   ```
4. Open `http://YOUR-SERVER-IP:3000` and sign in with the admin email and password.
5. Go to **People** and add your managers, team leads and employees.

The admin account is created only on the first start, when the database is empty. Change its password after signing in (click your name at the top).

Update after changing code: `docker compose up -d --build`
View logs: `docker compose logs -f`

## Option 2: Run without Docker

Needs Node.js 18 or newer.

```bash
npm install
ADMIN_EMAIL=admin@yourcompany.com ADMIN_PASSWORD='ChangeThisPassword!' npm start
```

To keep it running after you log out, use a process manager such as PM2:
```bash
npm install -g pm2
ADMIN_EMAIL=admin@yourcompany.com ADMIN_PASSWORD='ChangeThisPassword!' pm2 start server.js --name taskdesk
pm2 save && pm2 startup
```

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the app listens on |
| `DATA_DIR` | `./data` | Where the database file is stored |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | `admin@example.com` / `ChangeMe123!` | First admin account (first start only) |
| `COOKIE_SECURE` | `false` | Set to `true` once the site uses HTTPS |
| `TZ` | server time | Time zone used to decide when a task is overdue, e.g. `Asia/Kolkata` |

## HTTPS with Nginx (recommended for production)

Put Nginx in front of the app so people use `https://tasks.yourcompany.com`:

```nginx
server {
    server_name tasks.yourcompany.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 130m;   # 5 files of up to 25 MB each
    }
    # Chat live updates (Server-Sent Events): don't buffer, and keep the connection open.
    location /api/stream {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

Then get a free certificate with `sudo certbot --nginx -d tasks.yourcompany.com`, and set `COOKIE_SECURE=true`.

## Backups

All data is in one file: `data/taskdesk.db`. Back it up regularly, for example with a daily cron job:

```bash
sqlite3 /path/to/taskdesk/data/taskdesk.db ".backup '/backups/taskdesk-$(date +%F).db'"
```

## How team leads work

When adding or editing a person, set **Reports to** to their team lead. A team lead can then assign tasks to everyone who reports to them. Managers and admins can assign tasks to anyone.

## Forgotten passwords

An admin or manager opens **People**, clicks **Edit** on the person, and types a new password.
