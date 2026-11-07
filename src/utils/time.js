// All attendance dates/times are handled in Pakistan time (UTC+5, no DST).
const TZ = 'Asia/Karachi';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
});

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const dateKey = (d = new Date()) => dateFmt.format(d); // YYYY-MM-DD
export const timeKey = (d) => (d ? timeFmt.format(d).replace('24:', '00:') : null); // HH:mm

export const minutesOfDay = (d) => {
  const [h, m] = timeKey(d).split(':').map(Number);
  return h * 60 + m;
};
export const hhmmToMinutes = (s) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
export const minutesToHHMM = (mins) => {
  const m = Math.round(mins);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export const dateFromKey = (key, hhmm = '00:00') => new Date(`${key}T${hhmm}:00+05:00`);

// 0 = Sunday ... 6 = Saturday
export const weekdayOfKey = (key) => new Date(`${key}T12:00:00+05:00`).getUTCDay();

export function datesBetween(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export const currentMonth = () => dateKey().slice(0, 7);

export function addDays(key, n) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
