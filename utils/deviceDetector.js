// Utility to parse user-agent and IP details for session tracking
function parseClientInfo(req) {
  const ua = req.headers['user-agent'] || 'Unknown';
  let deviceType = 'Desktop';
  if (/mobile|android|iphone|ipod|blackberry|iemobile|opera mini/i.test(ua)) {
    deviceType = 'Mobile';
  } else if (/ipad|tablet|playbook|silk/i.test(ua)) {
    deviceType = 'Tablet';
  }

  let browser = 'Unknown Browser';
  if (/edg/i.test(ua)) browser = 'Edge';
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua)) browser = 'Safari';
  else if (/opera|opr/i.test(ua)) browser = 'Opera';

  let os = 'Unknown OS';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/macintosh|mac os x/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  // IP extraction
  let ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '127.0.0.1';
  if (typeof ip === 'string' && ip.includes(',')) {
    ip = ip.split(',')[0].trim();
  }
  if (ip === '::1' || ip === '::ffff:127.0.0.1') ip = '127.0.0.1';

  // Human-readable location / origin indicator
  let location = 'Localhost / Internal';
  if (ip !== '127.0.0.1' && !ip.startsWith('192.168.') && !ip.startsWith('10.')) {
    location = 'Remote Access (' + ip + ')';
  }

  return {
    deviceType,
    browser,
    os,
    ip,
    location,
    userAgent: ua.slice(0, 200),
  };
}

module.exports = { parseClientInfo };
