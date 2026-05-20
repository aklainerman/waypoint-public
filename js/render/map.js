// js/render/map.js
//
// MAP TAB (v59) -- Leaflet-backed map of DoD / Hill / industry sites.
// Hardcoded MAP_LOCATIONS lookup table + manual coord overrides
// (localStorage) + jittering for co-located orgs + sidebar + legend.
//
// Originally at file-scope of the inline monolith; lifted to ES module
// in v184. Same classic-script-split pattern as v181/v182/v183.
//
// Exposes on window:
//   window.renderMap   -- entry point; called from tab activation,
//                          office-map sub-tab activator, and switch-case
//                          tab router. All call sites guarded by
//                          typeof renderMap === 'function'.
//
// All other declarations (MAP_LOCATIONS, MAP_SERVICE_COLOR,
// MAP_OVERRIDE_KEY, MAP_STATE, mapServiceColor, mapLoadOverrides,
// mapSaveOverrides, mapResolveCoords, mapJitter, mapEnsureBuilt,
// mapPinIcon, mapEscAttr, renderMapSidebar, renderMapLegend, the
// wireMap IIFE) are module-internal -- no external references in the
// rest of the monolith.
//
// Consumes from window: DB, escHtml, officeIsPriority, the Leaflet
// global L (from CDN <script> in <head>).

// =================================================================
// MAP TAB (v59) -- Leaflet + hardcoded location lookup
// =================================================================

// ---- Hardcoded lookup table (well-known DoD/Hill sites) ----
// Each entry: { name, coords:[lat,lng], aliases:[...] }
// Matching: case-insensitive substring of normalized location text.
// Order matters -- more-specific entries first so e.g. "MacDill AFB"
// matches before "Tampa".
const MAP_LOCATIONS = [
  // -------- The Pentagon / DC area --------
  { name: 'The Pentagon, Arlington, VA', coords:[38.8719, -77.0563], aliases:['the pentagon','pentagon'] },
  { name: 'US Capitol, Washington, DC',  coords:[38.8899, -77.0091], aliases:['us capitol','capitol hill','capitol, washington','capitol washington','the capitol'] },
  { name: 'Washington Navy Yard, DC',    coords:[38.8748, -77.0010], aliases:['washington navy yard','navy yard'] },
  { name: 'JB Anacostia-Bolling, DC',    coords:[38.8390, -76.9950], aliases:['anacostia-bolling','jb anacostia','bolling'] },
  { name: 'JB Andrews, MD',              coords:[38.8108, -76.8650], aliases:['jb andrews','joint base andrews','andrews afb'] },
  { name: 'Fort Belvoir, VA',            coords:[38.7079, -77.1456], aliases:['fort belvoir','ft belvoir','ft. belvoir'] },
  { name: 'Fort Meade, MD',              coords:[39.1083, -76.7460], aliases:['fort meade','ft meade','ft. meade'] },
  { name: 'Quantico, VA',                coords:[38.5224, -77.3128], aliases:['quantico','mcb quantico','marine corps base quantico'] },
  { name: 'NAS Patuxent River, MD',      coords:[38.2861, -76.4116], aliases:['patuxent river','nas patuxent','pax river'] },
  { name: 'Aberdeen Proving Ground, MD', coords:[39.4670, -76.1320], aliases:['aberdeen proving','aberdeen prov','apg, md'] },
  { name: 'Arlington, VA',               coords:[38.8816, -77.0910], aliases:['arlington, va','arlington va'] },
  { name: 'Washington, DC',              coords:[38.9072, -77.0369], aliases:['washington, dc','washington dc'] },

  // -------- Air Force --------
  { name: 'Wright-Patterson AFB, OH',    coords:[39.8262, -84.0483], aliases:['wright-patterson','wpafb','wright patterson'] },
  { name: 'Hanscom AFB, MA',             coords:[42.4596, -71.2876], aliases:['hanscom afb','hanscom field'] },
  { name: 'Hurlburt Field, FL',          coords:[30.4281, -86.6904], aliases:['hurlburt'] },
  { name: 'MacDill AFB, FL',             coords:[27.8493, -82.5210], aliases:['macdill afb','macdill','tampa, fl'] },
  { name: 'Eglin AFB, FL',               coords:[30.4626, -86.5475], aliases:['eglin afb','eglin'] },
  { name: 'Tyndall AFB, FL',             coords:[30.0697, -85.6080], aliases:['tyndall afb','tyndall'] },
  { name: 'Edwards AFB, CA',             coords:[34.9054, -117.8836], aliases:['edwards afb','edwards air force base'] },
  { name: 'Beale AFB, CA',               coords:[39.1361, -121.4364], aliases:['beale afb','beale'] },
  { name: 'Travis AFB, CA',              coords:[38.2625, -121.9272], aliases:['travis afb','travis'] },
  { name: 'Vandenberg SFB, CA',          coords:[34.7420, -120.5724], aliases:['vandenberg'] },
  { name: 'Hill AFB, UT',                coords:[41.1230, -111.9731], aliases:['hill afb','hill air force base'] },
  { name: 'Kirtland AFB, NM',            coords:[35.0428, -106.6094], aliases:['kirtland'] },
  { name: 'Tinker AFB, OK',              coords:[35.4147, -97.3866],  aliases:['tinker afb','tinker'] },
  { name: 'Robins AFB, GA',              coords:[32.6402, -83.5919],  aliases:['robins afb','robins air'] },
  { name: 'Scott AFB, IL',               coords:[38.5450, -89.8350],  aliases:['scott afb'] },
  { name: 'Homestead ARB, FL',           coords:[25.4884, -80.3838],  aliases:['homestead arb','homestead air'] },

  // -------- Space Force --------
  { name: 'Peterson SFB, CO',            coords:[38.8131, -104.7039], aliases:['peterson sfb','peterson afb'] },
  { name: 'Schriever SFB, CO',           coords:[38.8055, -104.5292], aliases:['schriever'] },
  { name: 'Buckley SFB, CO',             coords:[39.7026, -104.7470], aliases:['buckley'] },
  { name: 'Patrick SFB, FL',             coords:[28.2356, -80.6101],  aliases:['patrick sfb','patrick afb','patrick space'] },
  { name: 'Cape Canaveral SFS, FL',      coords:[28.4889, -80.5778],  aliases:['cape canaveral'] },
  { name: 'Los Angeles AFB, CA',         coords:[33.9192, -118.3768], aliases:['los angeles afb','la afb'] },

  // -------- Army --------
  { name: 'Fort Liberty, NC',            coords:[35.1416, -79.0061], aliases:['fort liberty','fort bragg','ft bragg','ft. bragg','ft liberty'] },
  { name: 'Fort Campbell, KY',           coords:[36.6700, -87.4631], aliases:['fort campbell','ft campbell'] },
  { name: 'Fort Drum, NY',               coords:[44.0531, -75.7610], aliases:['fort drum'] },
  { name: 'Fort Cavazos, TX',            coords:[31.1372, -97.7773], aliases:['fort cavazos','fort hood','ft hood','ft. hood'] },
  { name: 'Fort Carson, CO',             coords:[38.7344, -104.7894],aliases:['fort carson','ft carson'] },
  { name: 'Fort Stewart, GA',            coords:[31.8769, -81.6133], aliases:['fort stewart'] },
  { name: 'Fort Riley, KS',              coords:[39.0843, -96.7794], aliases:['fort riley'] },
  { name: 'Fort Sill, OK',               coords:[34.6571, -98.4017], aliases:['fort sill'] },
  { name: 'Fort Bliss, TX',              coords:[31.8131, -106.4244],aliases:['fort bliss'] },
  { name: 'Fort Knox, KY',               coords:[37.8911, -85.9636], aliases:['fort knox'] },
  { name: 'Fort Leavenworth, KS',        coords:[39.3499, -94.9223], aliases:['fort leavenworth','leavenworth, ks'] },
  { name: 'Fort Leonard Wood, MO',       coords:[37.7280, -92.1399], aliases:['fort leonard'] },
  { name: 'Fort Wainwright, AK',         coords:[64.8378, -147.6164],aliases:['fort wainwright'] },
  { name: 'Fort Moore, GA',              coords:[32.3530, -84.9705], aliases:['fort moore','fort benning','ft benning','ft. benning'] },
  { name: 'Fort Rucker, AL',             coords:[31.3458, -85.7117], aliases:['fort rucker','fort novosel'] },
  { name: 'Fort Sam Houston, TX',        coords:[29.4528, -98.4477], aliases:['fort sam houston','jb san antonio','joint base san antonio'] },
  { name: 'Fort Gregg-Adams, VA',        coords:[37.2435, -77.3320], aliases:['fort gregg-adams','fort lee','ft lee','ft. lee'] },
  { name: 'Fort Huachuca, AZ',           coords:[31.5550, -110.3492],aliases:['fort huachuca'] },
  { name: 'Fort Eisenhower, GA',         coords:[33.4221, -82.1431], aliases:['fort eisenhower','fort gordon','ft gordon'] },
  { name: 'Fort Johnson, LA',            coords:[31.0490, -93.1985], aliases:['fort johnson','fort polk','ft polk'] },
  { name: 'Picatinny Arsenal, NJ',       coords:[40.9748, -74.5453], aliases:['picatinny'] },
  { name: 'Redstone Arsenal, AL',        coords:[34.6840, -86.6431], aliases:['redstone'] },
  { name: 'Bluegrass Station, KY',       coords:[38.0090, -84.3920], aliases:['bluegrass station'] },
  { name: 'West Point, NY',              coords:[41.3915, -73.9569], aliases:['west point'] },
  { name: 'Warren, MI (Detroit Arsenal)',coords:[42.5145, -83.0146], aliases:['warren, mi','detroit arsenal','warren mi'] },
  { name: 'Joint Base Lewis-McChord, WA',coords:[47.0894, -122.5814],aliases:['lewis-mcchord','jblm','jb lewis'] },
  { name: 'Huntsville, AL',              coords:[34.7304, -86.5861], aliases:['huntsville, al','huntsville al'] },

  // -------- Navy --------
  { name: 'Naval Base Norfolk, VA',      coords:[36.9450, -76.3306], aliases:['naval base norfolk','norfolk, va','norfolk va','nb norfolk'] },
  { name: 'Naval Base San Diego, CA',    coords:[32.6749, -117.1147],aliases:['naval base san diego','nb san diego'] },
  { name: 'Naval Station Newport, RI',   coords:[41.5197, -71.3253], aliases:['naval station newport'] },
  { name: 'Coronado, CA',                coords:[32.6859, -117.1831],aliases:['coronado'] },
  { name: 'NAS Pensacola, FL',           coords:[30.3500, -87.3055], aliases:['nas pensacola'] },
  { name: 'NAS Jacksonville, FL',        coords:[30.2348, -81.6800], aliases:['nas jacksonville','nas jax'] },
  { name: 'NAS Whidbey Island, WA',      coords:[48.3517, -122.6557],aliases:['nas whidbey'] },

  // -------- Marines --------
  { name: 'Camp Lejeune, NC',            coords:[34.6803, -77.3469], aliases:['camp lejeune','mcb lejeune'] },
  { name: 'MCAS Cherry Point, NC',       coords:[34.9006, -76.8806], aliases:['mcas cherry point','cherry point'] },
  { name: 'MCAS New River, NC',          coords:[34.7077, -77.4408], aliases:['mcas new river'] },
  { name: 'MCAS Miramar, CA',            coords:[32.8678, -117.1424],aliases:['mcas miramar'] },
  { name: 'Camp Pendleton, CA',          coords:[33.3866, -117.5731],aliases:['camp pendleton','mcb camp pendleton','pendleton'] },
  { name: 'MCAS Kaneohe Bay, HI',        coords:[21.4395, -157.7561],aliases:['mcas kaneohe','kaneohe bay'] },
  { name: 'MCAS Yuma, AZ',               coords:[32.6562, -114.6056],aliases:['mcas yuma'] },
  { name: 'Albany, GA',                  coords:[31.5785, -84.1557], aliases:['albany, ga','mclb albany'] },

  // -------- Hawaii / INDOPACOM --------
  { name: 'Camp H.M. Smith, HI',         coords:[21.3939, -157.9012],aliases:['camp h.m. smith','camp smith','indopacom'] },
  { name: 'JB Pearl Harbor-Hickam, HI',  coords:[21.3469, -157.9492],aliases:['pearl harbor','jb pearl harbor','hickam'] },
  { name: 'Schofield Barracks, HI',      coords:[21.5006, -158.0719],aliases:['schofield'] },

  // -------- SOCOM / DIU / DARPA / Industry hubs --------
  { name: 'Mountain View, CA (DIU HQ)',  coords:[37.4143, -122.0432],aliases:['mountain view','diu hq'] },
  { name: 'Tampa, FL (SOCOM)',           coords:[27.9506, -82.4572], aliases:['tampa, fl','tampa fl'] },
  { name: 'Doral, FL (SOUTHCOM)',        coords:[25.8195, -80.3553], aliases:['doral','southcom','miami / doral'] },
  { name: 'Austin, TX (AFC)',            coords:[30.2672, -97.7431], aliases:['austin, tx','austin tx'] },
  { name: 'Las Vegas, NV',               coords:[36.1699, -115.1398],aliases:['las vegas, nv','nellis'] },
  { name: 'Los Angeles, CA',             coords:[34.0522, -118.2437],aliases:['los angeles, ca','los angeles ca'] },
  { name: 'Tucson, AZ (ANG AATC)',       coords:[32.2226, -110.9747],aliases:['tucson, az','tucson az'] },

  // -------- Overseas --------
  { name: 'Stuttgart, Germany (EUCOM/AFRICOM)', coords:[48.7758, 9.1829],   aliases:['stuttgart, germany','stuttgart germany','eucom','africom'] },
  { name: 'Ramstein AB, Germany',         coords:[49.4399, 7.6004],   aliases:['ramstein'] },
  { name: 'Spangdahlem AB, Germany',      coords:[49.9728, 6.6921],   aliases:['spangdahlem'] },
  { name: 'Yokota AB, Japan',             coords:[35.7475, 139.3486], aliases:['yokota'] },
  { name: 'Kadena AB, Japan',             coords:[26.3550, 127.7689], aliases:['kadena','okinawa'] },
  { name: 'Andersen AFB, Guam',           coords:[13.5836, 144.9302], aliases:['andersen afb','guam'] },
];

// Service color palette -- match the existing Graph tab palette.
const MAP_SERVICE_COLOR = {
  'Air Force':   '#5C9DEB',
  'Space Force': '#5C9DEB',
  'Army':        '#7DAE5A',
  'Navy':        '#3A4F7A',
  'Marines':     '#A03030',
  'SOCOM':       '#D88E1F',
  'Joint':       '#7B5BA6',
  'OSD':         '#7B5BA6',
  'Congress':    '#C8102E',
  'Other':       '#888888',
};
function mapServiceColor(svc) { return MAP_SERVICE_COLOR[svc] || '#888'; }

// localStorage-backed manual coordinate overrides
//   { officeId: { lat, lng } }
const MAP_OVERRIDE_KEY = 'waypoint-map-overrides-v1';
function mapLoadOverrides() {
  try { return JSON.parse(localStorage.getItem(MAP_OVERRIDE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function mapSaveOverrides(o) {
  try { localStorage.setItem(MAP_OVERRIDE_KEY, JSON.stringify(o || {})); }
  catch (e) { /* ignore */ }
}

// Resolve an office to coordinates: explicit override -> lookup table -> null.
function mapResolveCoords(o, overrides) {
  if (!o) return null;
  overrides = overrides || mapLoadOverrides();
  const ov = overrides[o.id];
  if (ov && typeof ov.lat === 'number' && typeof ov.lng === 'number') {
    return { coords: [ov.lat, ov.lng], match: { name: '(manual)', source: 'override' } };
  }
  const text = String(o.location || '').toLowerCase();
  if (!text) return null;
  for (const m of MAP_LOCATIONS) {
    for (const alias of m.aliases) {
      if (text.indexOf(alias) !== -1) {
        return { coords: m.coords, match: { name: m.name, source: 'lookup' } };
      }
    }
  }
  return null;
}

// Deterministic small jitter for collision spreading.
function mapJitter(lat, lng, key) {
  // Hash the key into a small angle + radius (~80m max)
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const angle = ((Math.abs(h) % 360) * Math.PI) / 180;
  const radius = 0.0006 + ((Math.abs(h >> 8) % 40) * 0.00002); // ~67-156m
  return [lat + Math.sin(angle) * radius, lng + Math.cos(angle) * radius];
}

// ---- Renderer state ----
let MAP_STATE = {
  map: null,
  orgLayer: null,
  contactLayer: null,
};

function mapEnsureBuilt() {
  if (MAP_STATE.map) return MAP_STATE.map;
  const el = document.getElementById('mapCanvas');
  if (!el) return null;
  const m = L.map(el, { worldCopyJump: true });
  // CONUS-centered default view.
  m.setView([39.8283, -98.5795], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(m);
  MAP_STATE.map = m;
  MAP_STATE.orgLayer = L.layerGroup().addTo(m);
  MAP_STATE.contactLayer = L.layerGroup();
  return m;
}

function mapPinIcon(color, opts) {
  const size = (opts && opts.size) || 16;
  const cls = ['map-pin'];
  if (opts && opts.priority) cls.push('map-pin--priority');
  if (opts && opts.contact)  cls.push('map-pin--contact');
  return L.divIcon({
    html: '<div class="' + cls.join(' ') + '" style="width:' + size + 'px;height:' + size + 'px;background:' + color + ';"></div>',
    className: '',
    iconSize: [size, size],
    iconAnchor: [size/2, size/2],
    popupAnchor: [0, -size/2],
  });
}

function mapEscAttr(s) { return escHtml(String(s)); }

function renderMap() {
  const m = mapEnsureBuilt();
  if (!m) return;
  // Force a re-layout if the tab was hidden during init.
  setTimeout(() => m.invalidateSize(), 0);

  const q   = ((document.getElementById('mapSearch')         ||{}).value || '').toLowerCase();
  const svc = (document.getElementById('mapServiceFilter')   ||{}).value || '';
  const priOnly = (document.getElementById('mapPriorityOnly')||{}).checked || false;
  const conOnly = (document.getElementById('mapHasContactsOnly')||{}).checked || false;
  const champOnly = (document.getElementById('mapHasChampionOnly')||{}).checked || false;
  const showCon = (document.getElementById('mapShowContacts')||{}).checked || false;
  const sizeByCon = (document.getElementById('mapSizeByContacts')||{}).checked || false;

  const offices = DB.list('offices');
  const contacts = DB.list('contacts');
  const counts = (typeof computeOfficeCounts === 'function') ? computeOfficeCounts() : {};
  const overrides = mapLoadOverrides();

  // Apply filters.
  function passOrgFilters(o) {
    if (svc && (o.service||'') !== svc) return false;
    if (priOnly && !officeIsPriority(o)) return false;
    if (conOnly && !contacts.some(c => (c.officeIds||[]).includes(o.id))) return false;
    if (champOnly && !contacts.some(c => c.champion && (c.officeIds||[]).includes(o.id))) return false;
    if (q) {
      const blob = [o.name, o.fullName, o.service, o.location].join(' ').toLowerCase();
      const conBlob = contacts.filter(c => (c.officeIds||[]).includes(o.id))
        .map(c => [c.firstName, c.lastName, c.title].join(' ')).join(' ').toLowerCase();
      if (blob.indexOf(q) === -1 && conBlob.indexOf(q) === -1) return false;
    }
    return true;
  }

  // Pin size. Default: 14 / 18 (priority). When sizeByContacts is on,
  // diameter scales as sqrt(contactCount), clamped to a readable range.
  function mapPinDiameter(o, conN) {
    if (!sizeByCon) return officeIsPriority(o) ? 18 : 14;
    const grow = Math.sqrt(Math.max(0, conN));
    let d = Math.round(10 + grow * 5);
    if (officeIsPriority(o)) d += 2;
    return Math.max(10, Math.min(38, d));
  }

  // Bucket offices by status.
  const mapped = [];
  const unmapped = [];
  offices.forEach(o => {
    if (!passOrgFilters(o)) return;
    const r = mapResolveCoords(o, overrides);
    if (r) mapped.push({ o, coords: r.coords, match: r.match });
    else  unmapped.push(o);
  });
  // ALL unmapped (regardless of filter) for the sidebar count baseline -- but
  // apply filters so search narrows the sidebar in sync.
  const unmappedAll = offices.filter(o => passOrgFilters(o) && !mapResolveCoords(o, overrides));

  document.getElementById('mapMappedCount').textContent   = String(mapped.length);
  document.getElementById('mapUnmappedCount').textContent = String(unmappedAll.length);

  // Clear and re-draw layers.
  MAP_STATE.orgLayer.clearLayers();
  MAP_STATE.contactLayer.clearLayers();

  const allLatLngs = [];
  mapped.forEach(({ o, coords }) => {
    const [lat, lng] = mapJitter(coords[0], coords[1], o.id);
    allLatLngs.push([lat, lng]);
    const color = mapServiceColor(o.service);
    const pri = officeIsPriority(o);
    const c = counts[o.id] || {};
    const conN = contacts.filter(x => (x.officeIds||[]).includes(o.id)).length;
    const popup =
      '<div><strong>' + escHtml(o.name || o.id) + '</strong>' + (pri?' <span style="color:var(--priority);">&#9733;</span>':'') + '</div>'
      + (o.fullName ? '<div style="font-size:10.5px;color:var(--text-dim);margin-top:2px;">' + escHtml(o.fullName) + '</div>' : '')
      + '<div class="map-popup-counts">'
      +   '<span title="Service / branch">' + escHtml(o.service||'') + '</span>'
      +   (o.tier ? '<span>Tier ' + escHtml(String(o.tier)) + '</span>' : '')
      + '</div>'
      + '<div class="map-popup-counts">'
      +   '<span>CON ' + conN + '</span>'
      +   '<span>SOL ' + (c.solicitations||0) + '</span>'
      +   '<span>LOS ' + (c.los||0) + '</span>'
      +   '<span>CTR ' + (c.contracts||0) + '</span>'
      + '</div>'
      + '<div style="font-size:10.5px;color:var(--text-dim);">' + escHtml(o.location || '') + '</div>'
      + '<button class="map-popup-action" data-map-open-org="' + mapEscAttr(o.id) + '">Open in Orgs &rsaquo;</button>';
    L.marker([lat, lng], {
      icon: mapPinIcon(color, { size: mapPinDiameter(o, conN), priority: pri }),
      title: o.name || o.id,
    }).bindPopup(popup, { maxWidth: 280 }).addTo(MAP_STATE.orgLayer);
  });

  // Contacts overlay -- one pin per contact at their org's coords (jittered).
  if (showCon) {
    contacts.forEach(c => {
      const officesForC = (c.officeIds || []).map(id => DB.get('offices', id)).filter(Boolean);
      if (!officesForC.length) return;
      // Use first office for placement; same filters apply.
      const o = officesForC.find(passOrgFilters);
      if (!o) return;
      const r = mapResolveCoords(o, overrides);
      if (!r) return;
      const [lat, lng] = mapJitter(r.coords[0], r.coords[1], c.id);
      const color = c.champion ? '#FA824C' : mapServiceColor(o.service);
      const fullName = ((c.firstName||'') + ' ' + (c.lastName||'')).trim() || '(unnamed)';
      const popup =
        '<div><strong>' + escHtml(fullName) + '</strong>' + (c.champion?' <span style="color:var(--priority);">&#9733;</span>':'') + '</div>'
        + (c.title ? '<div style="font-size:10.5px;color:var(--text-dim);">' + escHtml(c.title) + '</div>' : '')
        + (c.rank  ? '<div style="font-size:10.5px;color:var(--text-dim);">' + escHtml(c.rank)  + '</div>' : '')
        + '<div style="font-size:10.5px;color:var(--text-dim);margin-top:3px;">at <em>' + escHtml(o.name) + '</em></div>'
        + '<button class="map-popup-action" data-map-open-contact="' + mapEscAttr(c.id) + '">Open in Contacts &rsaquo;</button>';
      L.marker([lat, lng], {
        icon: mapPinIcon(color, { contact: true }),
        title: fullName,
      }).bindPopup(popup, { maxWidth: 260 }).addTo(MAP_STATE.contactLayer);
    });
    if (!m.hasLayer(MAP_STATE.contactLayer)) MAP_STATE.contactLayer.addTo(m);
  } else {
    if (m.hasLayer(MAP_STATE.contactLayer)) m.removeLayer(MAP_STATE.contactLayer);
  }

  // Wire popup buttons (delegated -- popups create DOM lazily on open).
  m.off('popupopen').on('popupopen', (e) => {
    const root = e.popup.getElement();
    if (!root) return;
    root.querySelectorAll('[data-map-open-org]').forEach(b => b.addEventListener('click', () => {
      activateTab('offices');
      setTimeout(() => {
        const sf = document.getElementById('officesSearch');
        if (sf) {
          const o = DB.get('offices', b.dataset.mapOpenOrg);
          sf.value = (o && o.name) || ''; sf.dispatchEvent(new Event('input'));
        }
      }, 30);
    }));
    root.querySelectorAll('[data-map-open-contact]').forEach(b => b.addEventListener('click', () => {
      activateTab('contacts');
      setTimeout(() => {
        const c = DB.get('contacts', b.dataset.mapOpenContact);
        const sf = document.getElementById('contactsSearch');
        if (sf && c) {
          sf.value = ((c.firstName||'') + ' ' + (c.lastName||'')).trim();
          sf.dispatchEvent(new Event('input'));
        }
      }, 30);
    }));
  });

  // Fit bounds (only on first build or when explicitly invoked).
  if (!MAP_STATE._didInitFit && allLatLngs.length) {
    try { m.fitBounds(allLatLngs, { padding: [40,40], maxZoom: 7 }); } catch (e) {}
    MAP_STATE._didInitFit = true;
  }

  // Sidebar.
  renderMapSidebar(mapped, unmappedAll);

  // Legend.
  renderMapLegend({ sizeByCon });
}

function renderMapSidebar(mapped, unmapped) {
  const elM = document.getElementById('mapSideMapped');
  const elU = document.getElementById('mapSideUnmapped');
  document.getElementById('mapSideMappedHeading').textContent   = 'Mapped orgs (' + mapped.length + ')';
  document.getElementById('mapSideUnmappedHeading').textContent = 'Unmapped orgs (' + unmapped.length + ')';
  // Mapped list -- sort: priority first then alpha.
  const mSort = mapped.slice().sort((a,b) =>
    (officeIsPriority(b.o)?1:0) - (officeIsPriority(a.o)?1:0)
    || (a.o.name||'').localeCompare(b.o.name||''));
  elM.innerHTML = mSort.map(({ o, coords, match }) =>
    '<li class="map-sidebar-item" data-map-pan="' + mapEscAttr(o.id) + '" data-lat="' + coords[0] + '" data-lng="' + coords[1] + '">'
    + '<div>' + escHtml(o.name || o.id)
    +   (officeIsPriority(o) ? ' <span style="color:var(--priority);">&#9733;</span>' : '')
    + '</div>'
    + '<div class="meta">' + escHtml(match.name) + (match.source==='override'?' [manual]':'') + '</div>'
    + '</li>'
  ).join('');
  elM.querySelectorAll('[data-map-pan]').forEach(li => li.addEventListener('click', () => {
    const lat = parseFloat(li.dataset.lat), lng = parseFloat(li.dataset.lng);
    if (!isNaN(lat) && !isNaN(lng) && MAP_STATE.map) {
      MAP_STATE.map.setView([lat, lng], 11, { animate: true });
    }
  }));

  // Unmapped -- alpha sort, with inline "+ coords" form.
  const uSort = unmapped.slice().sort((a,b) => (a.name||'').localeCompare(b.name||''));
  elU.innerHTML = uSort.map(o =>
    '<li class="map-sidebar-item" data-office-id="' + mapEscAttr(o.id) + '">'
    + '<div class="map-sidebar-item-row">'
    +   '<div><div>' + escHtml(o.name || o.id) + '</div>'
    +   '<div class="meta">' + escHtml(o.location || '(no location set)') + '</div></div>'
    +   '<button class="small-add" data-map-add-form="' + mapEscAttr(o.id) + '">+ coords</button>'
    + '</div>'
    + '<div class="map-sidebar-edit" id="mapAddForm-' + mapEscAttr(o.id) + '" style="display:none;">'
    +   '<input type="number" step="0.0001" placeholder="lat"  data-coord="lat"  value="">'
    +   '<input type="number" step="0.0001" placeholder="lng"  data-coord="lng"  value="">'
    +   '<button data-map-save="' + mapEscAttr(o.id) + '">Save</button>'
    + '</div>'
    + '</li>'
  ).join('');
  elU.querySelectorAll('[data-map-add-form]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = b.dataset.mapAddForm;
    const f = document.getElementById('mapAddForm-' + id);
    if (f) f.style.display = (f.style.display === 'none' ? 'flex' : 'none');
  }));
  elU.querySelectorAll('[data-map-save]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = b.dataset.mapSave;
    const f = document.getElementById('mapAddForm-' + id);
    if (!f) return;
    const lat = parseFloat(f.querySelector('[data-coord="lat"]').value);
    const lng = parseFloat(f.querySelector('[data-coord="lng"]').value);
    if (isNaN(lat) || isNaN(lng)) { alert('Please enter both lat and lng as numbers.'); return; }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { alert('Out of range. Lat -90..90, lng -180..180.'); return; }
    const o = mapLoadOverrides();
    o[id] = { lat, lng };
    mapSaveOverrides(o);
    renderMap();
  }));
}

function renderMapLegend(opts) {
  const el = document.getElementById('mapLegend');
  if (!el) return;
  const services = ['Air Force','Army','Navy','Marines','SOCOM','Joint','OSD','Congress'];
  let html = '<strong>Service</strong>'
    + services.map(s => '<div class="map-legend-row"><div class="map-legend-swatch" style="background:' + mapServiceColor(s) + ';"></div>' + escHtml(s) + '</div>').join('');
  if (opts && opts.sizeByCon) {
    html += '<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:5px;">'
      +    '<strong>Size</strong>'
      +    '<div class="map-legend-row"><div class="map-legend-swatch" style="width:8px;height:8px;background:var(--text-dim);"></div>0 contacts</div>'
      +    '<div class="map-legend-row"><div class="map-legend-swatch" style="width:14px;height:14px;background:var(--text-dim);"></div>1-3</div>'
      +    '<div class="map-legend-row"><div class="map-legend-swatch" style="width:22px;height:22px;background:var(--text-dim);"></div>4-9</div>'
      +    '<div class="map-legend-row"><div class="map-legend-swatch" style="width:30px;height:30px;background:var(--text-dim);"></div>10+</div>'
      + '</div>';
  }
  el.innerHTML = html;
}

// Wire toolbar.
(function wireMap() {
  const ids = ['mapSearch','mapServiceFilter','mapPriorityOnly','mapHasContactsOnly','mapHasChampionOnly','mapShowContacts','mapSizeByContacts'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderMap);
    if (el) el.addEventListener('change', renderMap);
  });
  const fitBtn = document.getElementById('mapFitBtn');
  if (fitBtn) fitBtn.addEventListener('click', () => {
    MAP_STATE._didInitFit = false;
    renderMap();
  });
})();

// =================================================================
// =================================================================
window.renderMap = renderMap;
