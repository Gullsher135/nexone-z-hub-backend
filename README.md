# NexoneZ Attendance System: Backend (API)

Node.js, Express and MongoDB (Mongoose) REST API for tracking attendance of
**employees, interns and students**.

- **Employees and interns** log in, check in and check out (entry/exit time, late minutes, hours worked).
- **Students** do not log in. The admin or instructor marks them present/absent per batch and day.
- **Admin** registers everyone, corrects records, approves leave, sets office rules and exports reports.
- All dates and times use **Pakistan time (Asia/Karachi)**.

## Run locally

```bash
npm install
cp .env.example .env      # then fill in MONGODB_URI, JWT_SECRET, ADMIN_*
npm run dev               # http://localhost:5000
```

On first start, if no admin exists, one is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
Optional demo data: `npm run seed:demo`.

## Deploy on Render

1. Push this folder to its own GitHub repo.
2. Render, **New, Web Service**, connect the repo (or use **Blueprint** with `render.yaml`).
3. Build command `npm install`, start command `npm start`, health check path `/api/health`.
4. Environment variables:
   - `MONGODB_URI`: MongoDB Atlas connection string (Atlas Network Access must allow Render, e.g. `0.0.0.0/0`)
   - `JWT_SECRET`: long random string
   - `CLIENT_URL`: your Vercel URL, e.g. `https://nexonez-attendance.vercel.app` (comma-separate several; no trailing slash)
   - `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`: first admin account
5. Free Render services sleep after inactivity, so the first request after a break can take about 30-50 seconds.

## Check-in methods

| Method | How it works |
|---|---|
| Button | Employee taps Check in / Check out in the web app. |
| QR | Admin opens the **Office QR** screen; the code rotates every 60 s. Staff scan it with their phone. A QR scan proves presence, so it skips the location and network checks. |
| Location check (optional) | Admin sets office latitude/longitude and radius; button check-ins must be inside it. |
| Office network check (optional) | Admin lists the office public IP(s); button check-ins must come from them. Use `*` at the end for a prefix (e.g. `203.0.113.*`). |
| QR only (optional) | Disables the button completely. |

To set the network check up from anywhere: open **Settings, Office network check**, type the office's **public IP** (from the router's Status / Internet / WAN page) and press **Add IP**. Private addresses (192.168.x.x, 10.x.x.x, 172.16-31.x.x, 100.64-127.x.x) are rejected because the server can never see them. **Add my current IP** is only for use while connected to the office Wi-Fi. If your office internet has no fixed IP, the address can change; ask the provider for a static IP, or add the new one when check-ins start being refused. If the address shown looks wrong or changes between requests, set `TRUST_PROXY=2` on Render.

If the office internet address changes (no static IP), turn on **Update the office IP automatically** in the same section, press Save, press **Create the office link**, and open that private link on any device that stays at the office on the office network (a PC, laptop or old phone) and leave the page open. It calls `POST /api/office-sync/:key` every minute; the address the server sees is stored as `autoIp` and is allowed for check-in in addition to the manual list. The key can be replaced with **Make a new link** (`POST /api/settings/office-sync-key`).

To set the office location from anywhere: open **Settings, Office location check**, press **Open Google Maps**, copy the share link of the office pin, paste it and press **Get location**. The server reads the coordinates from the link (long links, `maps.app.goo.gl` short links and plain `lat, lng` text all work). The location check uses the phone's GPS, which can be spoofed, so for strict control use **QR only**.

## API overview (all under `/api`, JWT in `Authorization: Bearer <token>`)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password` |
| Users (admin) | `GET/POST /users`, `GET/PATCH/DELETE /users/:id`, `POST /users/:id/activate`, `/deactivate`, `/reset-password`, `POST /users/import-students` |
| Batches (admin) | `GET/POST /batches`, `PATCH/DELETE /batches/:id` |
| Staff attendance | `GET /attendance/today`, `GET /attendance/me?month=`, `POST /attendance/check-in`, `/check-out`, `/punch` |
| Staff attendance (admin) | `GET /attendance/qr`, `GET /attendance/board?date=`, `POST /attendance/manual`, `DELETE /attendance/:id` |
| Student attendance (admin) | `GET/PUT /student-attendance?batch=&date=`, `GET /student-attendance/summary?batch=&month=`, `GET /student-attendance/student/:id` |
| Leaves | staff: `POST /leaves`, `GET /leaves/me`, `DELETE /leaves/:id`; admin: `GET /leaves`, `PATCH /leaves/:id/review` |
| Reports (admin) | `GET /reports/dashboard`, `/reports/summary?month=`, `/reports/user/:id?month=`, `/reports/export?month=&detail=daily` (CSV) |
| Settings | `GET /settings`, `PUT /settings` (admin): weekend days, holidays, office location, allowed IPs, QR only; `GET /settings/my-ip`; `POST /settings/resolve-map` (Google Maps link to coordinates) |

## Notes

- Interns are blocked automatically after their internship end date.
- A person with attendance history is deactivated by default (history stays intact). The admin can still choose a permanent delete, which also removes that person's attendance and leave records (`DELETE /users/:id?force=true`).
- One check-in and one check-out per day; the admin can correct anything via manual entry (a reason is required).
- Login is rate limited (30 attempts / 15 min / IP).

## NexoneZ Pay (fees and payroll)
Endpoints under `/api/pay/*`: fee plans and installments, payments with numbered receipts (`RCPT-00001`), salary profiles, monthly payroll (generated from attendance, absent days deducted), payslips (paid ones are locked). No new environment variables. Redeploy backend and frontend.

## NexoneZ Flow (projects)
Endpoints under `/api/flow/*`: clients, projects (client, lead, team, deadline, budget visible to admin only), board cards (todo/doing/review/done) with comments, `my-work`, `overview`. Admin and project lead manage cards; assignees move their own cards. Removing a user unassigns their cards. No new environment variables.

## Letters and certificates (Crew)
Endpoints under `/api/docs/*`: internship certificates (only after the internship end date), experience letters (projects pulled from Flow), warning/notice letters (acknowledged by the employee), revoke, and public QR verification at `/api/docs/verify/:code` (warnings are never public). Course certificates use the same QR design. No new environment variables.
