// "Chrome on Android" from a user-agent string. Only for showing people which device is which.
export function deviceLabel(ua = '') {
  const s = String(ua);
  const os = /android/i.test(s) ? 'Android' : /iphone/i.test(s) ? 'iPhone' : /ipad/i.test(s) ? 'iPad' : /windows/i.test(s) ? 'Windows' : /cros/i.test(s) ? 'ChromeOS' : /mac os x|macintosh/i.test(s) ? 'Mac' : /linux/i.test(s) ? 'Linux' : '';
  const browser = /edg\//i.test(s) ? 'Edge' : /opr\/|opera/i.test(s) ? 'Opera' : /samsungbrowser/i.test(s) ? 'Samsung Internet' : /firefox|fxios/i.test(s) ? 'Firefox' : /chrome|crios/i.test(s) ? 'Chrome' : /safari/i.test(s) ? 'Safari' : '';
  if (!os && !browser) return 'Unknown device';
  return browser && os ? `${browser} on ${os}` : browser || os;
}
