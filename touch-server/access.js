'use strict';
/* Who may change the calibration. The table browser runs with Chrome's local-network-access check switched off (the
   Owlbear extension and D&D Sync need ws://localhost), so ANY page open in it can reach this service. Reading
   contacts is harmless; writing the calibration is not — only the service's own calibration page may do that
   (served from http://localhost:<port>), or a local program (no Origin header: browsers always send one). */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function canCalibrate(origin, port) {
  if (origin === undefined || origin === null || origin === '') return true;
  let u; try { u = new URL(origin); } catch (_) { return false; }
  return u.protocol === 'http:' && LOCAL_HOSTS.includes(u.hostname) && Number(u.port || 80) === Number(port);
}
module.exports = { canCalibrate };
