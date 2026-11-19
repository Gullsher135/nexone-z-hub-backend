# NexoneZ Attendance System: Backend (API)

Node.js, Express and MongoDB (Mongoose) REST API behind the NexoneZ Hub: attendance, learning,
fees and payroll, projects and letters.

- **Employees and interns** log in, check in and check out (entry/exit time, late minutes, hours worked).
- **Students log in** to their own portal (`/learn`): courses, assignments, quizzes, presentations, fees and progress.
- **Teachers** run their courses and batches, mark class attendance, quizzes, assignments and presentations.
- **Admin** registers everyone, corrects records, approves leave, runs fees and payroll, and can read the audit log.
- **Class attendance** is taken on Saturday and Sunday only (`CLASS_DAYS` in `src/utils/time.js`).
- All dates and times use **Pakistan time (Asia/Karachi)**.

## Run locally

```bash
npm install
cp .env.example .env      # then fill in MONGODB_URI, JWT_SECRET, ADMIN_*
npm run dev               # http://localhost:5000
```

On first start, if no admin exists, one is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
Optional demo data: `npm run seed:demo`.

Automated tests (fees, payroll, date rules and the file-storage signing) need no database:

```bash
npm test
```

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
   To avoid it, create a free monitor at UptimeRobot or cron-job.org that opens `https://YOUR-API.onrender.com/api/health` every 10 minutes.

## File storage (assignments, submissions, slides)

By default uploaded files are kept in MongoDB, which is fine for trying things out but fills the free Atlas plan (512 MB) quickly.
For real use, point the app at free S3-compatible object storage by filling these variables; nothing else changes:

| Variable | Example (Backblaze B2) |
|---|---|
| `S3_ENDPOINT` | `https://s3.us-west-004.backblazeb2.com` |
| `S3_REGION` | `us-west-004` |
| `S3_BUCKET` | `nexonez-files` (keep the bucket **private**) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | an Application Key limited to that bucket |

Backblaze B2 gives 10 GB free. Cloudflare R2 (10 GB free, needs a card on file) and other S3-compatible services work the same way.
Downloads still go through the API, so only logged-in people allowed to see a file can get it. Files already stored in MongoDB keep working;
new uploads go to the bucket. The server prints which storage it uses when it starts. Any file type is accepted, up to 10 MB each.

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
| Student attendance (admin, teacher) | `GET/PUT /student-attendance?batch=&date=` (Saturday and Sunday only), `GET /student-attendance/summary?batch=&month=`, `GET /student-attendance/student/:id` |
| Leaves | staff: `POST /leaves`, `GET /leaves/me`, `DELETE /leaves/:id`; admin: `GET /leaves`, `PATCH /leaves/:id/review` |
| Reports (admin) | `GET /reports/dashboard`, `/reports/summary?month=`, `/reports/user/:id?month=`, `/reports/export?month=&detail=daily` (CSV) |
| Settings | `GET /settings`, `PUT /settings` (admin): weekend days, holidays, office location, allowed IPs, QR only; `GET /settings/my-ip`; `POST /settings/resolve-map` (Google Maps link to coordinates) |

## Learning (`/api/lms/*`)

| Area | Endpoints |
|---|---|
| Assignments | per course and batch; students hand in files (any format), links and a note; teacher attachments |
| Quizzes | `kind` daily (multiple choice, automatic) or weekly (sections with multiple choice, true/false, short answer and coding questions); optional timer; written answers are marked by the teacher (`PATCH /lms/attempts/:id/grade`) |
| Presentations | per course and batch: a topic for every student (by hand or random), a marking list with marks for each item, optional slides upload |
| Files | `POST /lms/files` (raw bytes), `GET /lms/files/:id` |

## Audit log (admin)

`GET /api/audit?action=payment&from=&to=&page=` lists who changed fee plans, payments, salaries, payroll, payslips, manual
attendance, marks and grades, and account access, with before and after values. Entries are only ever added.

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
