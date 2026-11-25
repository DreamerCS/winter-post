const $ = (selector) => document.querySelector(selector);
const decoder = new TextDecoder();

function base64url(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

async function openCard(secret) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('incomplete');
  const [record, response] = await Promise.all([fetch('./recipient.json'), fetch('./card.bin')]);
  if (!record.ok || !response.ok) throw new Error('network');
  const publicKey = await record.json();
  const privateKey = await crypto.subtle.importKey('jwk', { ...publicKey, d: secret }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const sealed = new Uint8Array(await response.arrayBuffer());
  if (sealed.length < 94 || sealed[0] !== 4) throw new Error('incomplete');
  const ephemeral = await crypto.subtle.importKey('raw', sealed.slice(0, 65), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeral }, privateKey, 256);
  const hashed = await crypto.subtle.digest('SHA-256', shared);
  const aesKey = await crypto.subtle.importKey('raw', hashed, { name: 'AES-GCM' }, false, ['decrypt']);
  const contents = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(65, 77), additionalData: new TextEncoder().encode('Winter Post clean card v1') }, aesKey, sealed.slice(77));
  const card = JSON.parse(decoder.decode(contents));
  if (typeof card.note?.message !== 'string' || !Array.isArray(card.media)) throw new Error('incomplete');
  return card;
}

function setupLetter(note) {
  $('#salutation').textContent = note.to ? `Dear ${note.to},` : 'Dear you,';
  const lines = note.message.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  $('#letter-text').replaceChildren(...lines.map(line => { const p = document.createElement('p'); p.textContent = line; return p; }));
  // The letter intentionally has no public sender or signature.
  $('#signature').remove();
  document.querySelectorAll('[data-open-letter]').forEach(button => button.addEventListener('click', () => $('#letter-dialog').showModal()));
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));
  if (new URLSearchParams(location.search).has('letter')) setTimeout(() => $('#letter-dialog').showModal(), 650);
}

function setupMedia(media) {
  const objects = new Map(media.filter(item => typeof item.data === 'string' && typeof item.type === 'string').map(item => [item.name, URL.createObjectURL(new Blob([base64url(item.data)], { type: item.type }))]));
  const labels = [['dusk', 'AFTER THE SUNSET'], ['aurora', 'UNDER THE NORTHERN SKY'], ['blue-hour', 'THE BLUE HOUR']];
  const images = labels.filter(([key]) => objects.has(key));
  if (images.length) {
    $('#memories').hidden = false;
    const grid = $('#photos');
    let current = 0;
    function view(index) {
      current = (index + images.length) % images.length;
      $('#large-photo').src = objects.get(images[current][0]);
      $('#photo-position').textContent = `${current + 1} / ${images.length}`;
      $('#photo-dialog').showModal();
    }
    images.forEach(([key, label], index) => {
      const frame = document.createElement('button');
      frame.className = 'photo-card'; frame.type = 'button';
      frame.style.setProperty('--tilt', `${[-3, 2, -2][index % 3]}deg`);
      const img = document.createElement('img'); img.src = objects.get(key); img.alt = label.toLowerCase(); img.loading = 'lazy';
      const caption = document.createElement('span'); caption.textContent = `0${index + 1} / ${label}`;
      frame.append(img, caption); frame.addEventListener('click', () => view(index)); grid.append(frame);
    });
    $('#prev-photo').addEventListener('click', () => view(current - 1));
    $('#next-photo').addEventListener('click', () => view(current + 1));
  }
  setupSound();
}

function setupSound() {
  const button = $('#sound'); button.hidden = false;
  let audio, timer, position = 0;
  const notes = [392, 523.25, 659.25, 784, 659.25, 523.25, 440, 587.33];
  function chime() {
    if (!audio || document.hidden) return;
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.type = 'sine'; tone.frequency.value = notes[position++ % notes.length];
    gain.gain.setValueAtTime(0, audio.currentTime);
    gain.gain.linearRampToValueAtTime(.038, audio.currentTime + .04);
    gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + 1.7);
    tone.connect(gain).connect(audio.destination);
    tone.start(); tone.stop(audio.currentTime + 1.7);
  }
  button.addEventListener('click', async () => {
    if (timer) { clearInterval(timer); timer = undefined; button.textContent = '♫  PLAY AMBIENCE'; return; }
    audio ||= new AudioContext(); await audio.resume(); chime();
    timer = setInterval(chime, 750); button.textContent = '♫  PAUSE AMBIENCE';
  });
}

function setupCountdown() {
  const target = new Date(2026, 11, 25).getTime();
  const fields = ['days', 'hours', 'minutes', 'seconds'];
  function update() {
    const seconds = Math.max(0, Math.floor((target - Date.now()) / 1000));
    const values = [Math.floor(seconds / 86400), Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60];
    fields.forEach((field, index) => { $(`#${field}`).textContent = String(values[index]).padStart(2, '0'); });
    if (seconds === 0) $('#count-title').innerHTML = 'It is <em>Christmas.</em>';
  }
  update(); setInterval(update, 1000);
}

function setupTree() {
  const canvas = $('#tree'), ctx = canvas.getContext('2d');
  let width = 0, height = 0, scale = 1, yaw = -0.3, scattered = false, paused = matchMedia('(prefers-reduced-motion: reduce)').matches, dragging = false, lastX = 0, startX = 0, time = 0;
  let seed = 48921;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const particles = [];
  for (let i = 0; i < 2400; i++) {
    const level = random(), theta = random() * Math.PI * 2;
    const radius = (0.04 + 0.86 * level) * (0.72 + 0.28 * random());
    particles.push({ x: Math.cos(theta) * radius, y: -1.05 + 2.1 * level, z: Math.sin(theta) * radius, tint: random(), size: 0.45 + random() * 1.6, drift: random() * 6.28, fall: random() });
  }
  const snow = Array.from({ length: 100 }, () => ({ x: random(), y: random(), radius: random() * 1.6 + .5, speed: random() * .42 + .08 }));
  function resize() {
    const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height;
    scale = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }
  function frame() {
    ctx.clearRect(0, 0, width, height);
    const twinkle = paused ? 0 : time;
    const centre = width / 2, top = height * .16, units = Math.min(width * .48, height * .37);
    const halo = ctx.createRadialGradient(centre, height * .5, 5, centre, height * .5, units * 2.1);
    halo.addColorStop(0, '#af783227'); halo.addColorStop(1, '#9e642500');
    ctx.fillStyle = halo; ctx.fillRect(0, 0, width, height);
    for (const s of snow) {
      const y = ((s.y + twinkle * s.speed * .008) % 1) * height;
      ctx.globalAlpha = .16 + .18 * Math.sin(s.x * 110 + twinkle * 1.4) ** 2;
      ctx.fillStyle = '#f8dca9'; ctx.beginPath(); ctx.arc(s.x * width, y, s.radius, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const projected = particles.map(p => {
      const spread = scattered ? 1.6 + .4 * Math.sin(twinkle + p.drift) : 1;
      const x = p.x * spread, z = p.z * spread;
      const turnedX = x * Math.cos(yaw) - z * Math.sin(yaw);
      const turnedZ = x * Math.sin(yaw) + z * Math.cos(yaw);
      const perspective = 3.4 / (3.4 + turnedZ);
      const lifted = scattered ? Math.sin(p.drift * 2 + twinkle * .7) * .19 : 0;
      return { x: centre + turnedX * units * perspective, y: top + (p.y + 1.08 + lifted) * units * .95, z: turnedZ, r: p.size * perspective * (width < 600 ? .8 : 1), tint: p.tint, shimmer: Math.sin(p.drift + twinkle * 2) };
    }).sort((a, b) => b.z - a.z);
    ctx.shadowColor = '#c99239'; ctx.shadowBlur = 8;
    for (const p of projected) {
      ctx.globalAlpha = .48 + .42 * p.tint + .1 * p.shimmer;
      ctx.fillStyle = p.tint > .78 ? '#fff1c8' : p.tint > .35 ? '#deb46e' : '#9e6c36';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    const starY = top - 5, starR = Math.min(25, units * .085);
    ctx.save(); ctx.translate(centre, starY); ctx.rotate(twinkle * .1);
    ctx.shadowColor = '#ffd681'; ctx.shadowBlur = 30; ctx.fillStyle = '#fff0bb'; ctx.beginPath();
    for (let n = 0; n < 16; n++) {
      const a = n * Math.PI / 8 - Math.PI / 2, r = n % 2 ? starR * .23 : starR;
      if (!n) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill(); ctx.restore();
    if (!paused && !dragging) { time += 1 / 60; yaw += .0017; }
    requestAnimationFrame(frame);
  }
  canvas.addEventListener('pointerdown', event => { dragging = true; startX = lastX = event.clientX; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointermove', event => { if (dragging) { yaw += (event.clientX - lastX) * .008; lastX = event.clientX; } });
  canvas.addEventListener('pointerup', event => { if (dragging && Math.abs(event.clientX - startX) < 5) scattered = !scattered; dragging = false; });
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  canvas.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); scattered = !scattered; } if (event.key === 'ArrowRight') yaw += .13; if (event.key === 'ArrowLeft') yaw -= .13; });
  $('#scatter').addEventListener('click', () => { scattered = !scattered; $('#scatter').firstChild.textContent = scattered ? 'Gather the stars ' : 'Scatter the stars '; });
  $('#turn').addEventListener('click', () => { yaw += Math.PI / 3; });
  $('#motion').addEventListener('click', () => { paused = !paused; $('#motion').firstChild.textContent = paused ? 'Resume motion ' : 'Pause motion '; });
  window.addEventListener('resize', resize); resize(); requestAnimationFrame(frame);
}

async function enter() {
  const secret = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (!secret) return;
  $('#gate-message').textContent = 'Opening the stars…';
  try {
    const card = await openCard(secret);
    setupLetter(card.note); setupMedia(card.media); setupCountdown(); setupTree();
    $('#gate').hidden = true; $('#experience').hidden = false;
  } catch (error) {
    $('#gate-message').textContent = error.message === 'incomplete' || error.name === 'OperationError' || error.name === 'DataError'
      ? 'This link is incomplete. Please open the full invitation link.' : 'The letter could not be opened. Check your connection and try again.';
    $('#retry').hidden = false;
  }
}
$('#retry').addEventListener('click', enter);
enter();
