/*
 * Passages à niveau — calculateur générique de croisements route/voie ferrée.
 * Logique de l'application (calcul des croisements route/voie ferrée,
 * horaires des trains, rendu carte + liste).
 *
 * Sources de données :
 *  - ROUTE (tracé GPS)      : un GPX importé.
 *  - PN_DATA (passages à niveau) : API en direct SNCF Réseau (ArcGIS FeatureServer),
 *                                  interrogée sur la zone géographique (bbox) du tracé actuel —
 *                                  donc les lignes SNCF traversées sont détectées automatiquement,
 *                                  pas besoin de les connaître à l'avance. Repli sur data/pn.json
 *                                  uniquement pour le tracé d'origine (zone Jard–Les Herbiers).
 *  - RAIL_DATA (voies ferrées)   : API en direct SNCF (portail officiel, "formes-des-lignes-du-rfn"),
 *                                  même logique de zone géographique + repli.
 *  - Horaires trains (SCHEDULE) : API SNCF temps réel (moteur Navitia), via un petit backend
 *                                  relais (server/index.js) qui garde la clé API côté serveur.
 *                                  Pour chaque PN, le backend trouve la gare la plus proche et
 *                                  renvoie ses prochains passages réels — voir fetchPNSchedule()
 *                                  et loadSchedulesForCrossings() plus bas. Fonctionne pour
 *                                  n'importe quel tracé importé, pas seulement Jard–Les Herbiers.
 */
// Attendre que le DOM soit chargé
document.addEventListener('DOMContentLoaded', function() {
    // Récupère la date du jour au format YYYY-MM-DD
    const today = new Date().toISOString().split('T')[0];

    // Définit la valeur du champ startDate
    document.getElementById('startDate').value = today;
});

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    // On essaie de récupérer le corps de la réponse : les API type Opendatasoft/ArcGIS
    // renvoient en général un message d'erreur exploitable (champ inconnu, syntaxe ODSQL
    // invalide, etc.), bien plus utile que le simple code HTTP pour diagnostiquer.
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
    throw new Error("Échec " + res.status + " sur " + url + (detail ? " — " + detail : ""));
  }
  return res.json();
}

// Calcule la zone géographique (bbox) couverte par un tracé, avec une marge de sécurité
// (en mètres) pour être sûr de capter les voies/PN juste à la frontière du tracé.
function computeBBoxLatLon(route, marginMeters) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  route.forEach(([lat, lon]) => {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  });
  const midLat = (minLat + maxLat) / 2;
  const dLat = marginMeters / 110540;
  const dLon = marginMeters / (111320 * Math.cos(midLat * Math.PI / 180));
  return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
}

// ---------- PN officiels : API SNCF Réseau en direct (portail officiel SNCF Open Data) ----------
// Important : on utilise le jeu de données national "liste-des-passages-a-niveau", hébergé
// directement sur ressources.data.sncf.com — PAS le calque ArcGIS testé initialement
// (services2.arcgis.com/.../Passages_a_niveau), dont il s'est avéré qu'il ne couvre que le
// nord de la France (Bretagne/Normandie/Hauts-de-France), pas la Vendée ni le Sud.
// Filtre spatial (in_bbox) plutôt que par code de ligne : ça détecte automatiquement toutes les
// lignes traversées par le tracé, sans avoir besoin de les connaître à l'avance.
function pick(obj, ...keys) {
  for (const k of keys) { if (obj[k] !== undefined && obj[k] !== null) return obj[k]; }
  return undefined;
}
// Le champ geo_point_2d peut être renvoyé sous plusieurs formes selon la version de l'API
// ([lat,lon], [lon,lat], {lat,lon}, {lon,lat}...). On désambiguïse avec une heuristique fiable
// pour la France métropolitaine : latitude ∈ [40,52], longitude ∈ [-6,10] (plages disjointes).
function extractLatLon(geoPoint) {
  if (!geoPoint) return null;
  let a, b;
  if (Array.isArray(geoPoint)) { [a, b] = geoPoint; }
  else if (typeof geoPoint === 'object') {
    a = pick(geoPoint, 'lat', 'latitude');
    b = pick(geoPoint, 'lon', 'lng', 'longitude');
    if (a === undefined || b === undefined) { const v = Object.values(geoPoint); [a, b] = v; }
  }
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return (Math.abs(a) >= 40 && Math.abs(a) <= 52) ? [a, b] : [b, a];
}
async function fetchPNLive(bbox) {
  const base = 'https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/'
    + 'liste-des-passages-a-niveau/records';
  const where = encodeURIComponent(
    `in_bbox(geo_point_2d, ${bbox.maxLat}, ${bbox.minLon}, ${bbox.minLat}, ${bbox.maxLon})`
  );
  const limit = 100;
  let offset = 0;
  let all = [];
  for (let page = 0; page < 50; page++) { // garde-fou : 50 pages max (5000 PN)
    const url = `${base}?where=${where}&limit=${limit}&offset=${offset}`;
    if (page === 0) console.info('[PN] requête :', url);
    const data = await loadJSON(url);
    if (!data || !Array.isArray(data.results)) throw new Error("Réponse PN inattendue (schéma imprévu)");
    all = all.concat(data.results);
    offset += limit;
    if (data.results.length < limit || (data.total_count != null && offset >= data.total_count)) break;
  }
  // Un tableau vide est un résultat légitime (zone sans passage à niveau) : ce n'est pas une erreur.
  const out = [];
  all.forEach(r => {
    const pt = extractLatLon(r.geo_point_2d);
    if (!pt) return;
    out.push({
      lat: pt[0], lon: pt[1],
      libelle: pick(r, 'libelle', 'libelle_if', 'libelle_pn'),
      mnemo: pick(r, 'mnemo', 'mnemo_type_if', 'mnemo_type', 'classe'),
      obstacle: pick(r, 'obstacle', 'libelle_ob', 'libelle_obstacle'),
      ligne: String(pick(r, 'code_ligne', 'codeligne') ?? '?'),
      pk: pick(r, 'pk', 'pk_sncf'),
      commune: pick(r, 'saco_libelle_commune', 'commune', 'commune_pn') || '',
    });
  });
  return out;
}

// ---------- Géométrie des voies : API SNCF en direct (portail officiel SNCF Open Data) ----------
// Important : on interroge directement le portail SNCF (ressources.data.sncf.com), pas
// l'agrégateur générique data.opendatasoft.com — celui-ci a changé de plateforme (rebranding
// "Huwise" fin 2025) et ne sert plus correctement ce jeu de données en miroir.
// Filtre spatial (in_bbox) plutôt que par code de ligne : mêmes raisons que pour les PN.
async function fetchRailLive(bbox) {
  const base = 'https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/'
    + 'formes-des-lignes-du-rfn/records';
  const where = encodeURIComponent(
    `in_bbox(geo_shape, ${bbox.maxLat}, ${bbox.minLon}, ${bbox.minLat}, ${bbox.maxLon})`
  );
  const limit = 100;
  let offset = 0;
  let all = [];
  for (let page = 0; page < 50; page++) { // garde-fou : 50 pages max (5000 tronçons)
    const url = `${base}?where=${where}&limit=${limit}&offset=${offset}`;
    if (page === 0) console.info('[Voies] requête :', url);
    const data = await loadJSON(url);
    if (!data || !Array.isArray(data.results)) throw new Error("Réponse voies inattendue (schéma imprévu)");
    all = all.concat(data.results);
    offset += limit;
    if (data.results.length < limit || (data.total_count != null && offset >= data.total_count)) break;
  }
  // Un tableau vide est un résultat légitime (zone sans voie ferrée à proximité).

  const segments = [];
  all.forEach(r => {
    const shape = r.geo_shape;
    const ligne = String(r.code_ligne);
    if (!shape || !shape.geometry) return;
    const geomType = shape.geometry.type;
    const lines = geomType === 'MultiLineString' ? shape.geometry.coordinates
                : geomType === 'LineString' ? [shape.geometry.coordinates]
                : null;
    if (!lines) return;
    lines.forEach(coords => {
      for (let i = 1; i < coords.length; i++) {
        const [lon1, lat1] = coords[i - 1];
        const [lon2, lat2] = coords[i];
        segments.push({ a: [lat1, lon1], b: [lat2, lon2], l: ligne });
      }
    });
  });
  return segments;
}

// Charge une source "live" avec repli optionnel sur un fichier local en cas d'échec.
// Le repli n'a de sens que pour le tracé d'origine (les fichiers locaux ne couvrent que sa
// zone géographique) : pour un tracé importé ailleurs en France, on préfère afficher clairement
// que la vérification a échoué plutôt que d'utiliser des données d'une autre région.
async function withFallback(label, liveFn, localPath, allowLocalFallback) {
  try {
    const data = await liveFn();
    console.info(`[${label}] données en direct chargées depuis l'API SNCF Réseau (${data.length} élément(s)).`);
    return { data, source: 'live' };
  } catch (err) {
    console.warn(`[${label}] API en direct indisponible (${err.message}).`);
    if (allowLocalFallback) {
      const data = await loadJSON(localPath);
      console.warn(`[${label}] repli sur ${localPath}.`);
      return { data, source: 'local (repli)' };
    }
    return { data: [], source: 'indisponible', error: err.message };
  }
}

async function init() {
  let ROUTE = [];
  let ROUTE_ORIGINAL = null;
  try {
    ROUTE = await loadJSON('data/route.json');
    ROUTE_ORIGINAL = ROUTE; // gardé de côté pour le bouton "tracé d'origine"
  } catch (e) {
    console.warn('Aucun tracé par défaut — en attente d\'un import GPX.');
  }
  // Les horaires ne viennent plus d'un fichier local pré-calculé : ils sont
  // demandés en direct au backend (relais vers l'API SNCF temps réel), gare
  // la plus proche de chaque PN, pour la date choisie. Voir fetchPNSchedule().
  // Table de référence "type de trafic par ligne" (TER/Intercités/TGV/aucun...), construite au
  // fil des lignes réellement rencontrées via recherche web — pas une source SNCF officielle,
  // pas de couverture nationale. Une ligne absente de cette table = pas encore recherchée.
  let LINE_TYPES = {};
  try { LINE_TYPES = await loadJSON('data/line-types.json'); } catch (e) { console.warn('line-types.json indisponible:', e.message); }

  let PN_DATA = [];
  let RAIL_DATA = [];
  const badgeEl = document.querySelector('.badge');

  // ---------- geometry ----------
  function toRad(d){ return d*Math.PI/180; }
  function haversine(a,b){
    const R=6371000;
    const dLat=toRad(b[0]-a[0]), dLon=toRad(b[1]-a[1]);
    const la1=toRad(a[0]), la2=toRad(b[0]);
    const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
    return R*2*Math.asin(Math.sqrt(h));
  }
  function pointToSegment(p, a, b){
    const lat0 = toRad(a[0]);
    const kx = 111320*Math.cos(lat0), ky = 110540;
    const toXY = (pt)=>[ (pt[1]-a[1])*kx, (pt[0]-a[0])*ky ];
    const P=toXY(p), A=[0,0], B=toXY(b);
    const ABx=B[0]-A[0], ABy=B[1]-A[1];
    const len2 = ABx*ABx+ABy*ABy;
    let t = len2===0 ? 0 : ((P[0]-A[0])*ABx + (P[1]-A[1])*ABy)/len2;
    t = Math.max(0, Math.min(1, t));
    const projX = A[0]+ABx*t, projY = A[1]+ABy*t;
    const dx = P[0]-projX, dy = P[1]-projY;
    return {dist: Math.sqrt(dx*dx+dy*dy), t};
  }
  
  function fmtLigne(code){
    // SNCF line codes are 6-digit strings, e.g. "530000" -> "530000"
    return "L" + code;
  }
  function fmtKm(m){ return (m/1000).toFixed(1)+" km"; }
  function fmtTimeFromMinutes(startMin, addMin){
    let total = Math.round(startMin+addMin);
    total = ((total%1440)+1440)%1440;
    const h=Math.floor(total/60), m=total%60;
    return String(h).padStart(2,'0')+"h"+String(m).padStart(2,'0');
  }
  function parseTimeToMinutes(hhmm){
    const [h,m]=hhmm.split(':').map(Number);
    return h*60+m;
  }
  
  // ---------- map ----------
  // Carte Leaflet centrée sur le tracé (ou sur la France si aucun tracé).
  const FRANCE_CENTRE = [46.6, 1.88];
  const FRANCE_ZOOM = 6;
  const center = ROUTE.length ? ROUTE[Math.floor(ROUTE.length/2)] : FRANCE_CENTRE;
  const zoom = ROUTE.length ? 10 : FRANCE_ZOOM;
  const map = L.map('map', {zoomControl:true}).setView(center, zoom);
  
  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors', maxZoom: 19
  });
  const darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO', maxZoom: 19
  });
  osmLayer.addTo(map); // OSM standard by default, for orientation (road names, places)
  L.control.layers({ 'Fond OSM (repères)': osmLayer, 'Fond sombre': darkLayer }, null, {position:'topright'}).addTo(map);
  
  // Le tracé (ROUTE) est maintenant remplaçable à la volée (import GPX). cum/totalDist et
  // les calques carte du tracé sont recalculés/redessinés à chaque appel de drawRoute().
  let cum = [0], totalDist = 0;
  let routeLine = null, startMarker = null, endMarker = null;
  
  function drawRoute(points){
    ROUTE = points;
    if (routeLine) map.removeLayer(routeLine);
    if (startMarker) map.removeLayer(startMarker);
    if (endMarker) map.removeLayer(endMarker);
    routeLine = startMarker = endMarker = null;

    if (!ROUTE.length) {
      cum = [0]; totalDist = 0;
      document.getElementById('statDist').textContent = '–';
      map.setView([46.6, 1.88], 6); // revient sur la vue France si le tracé est vidé
      return;
    }

    cum = [0];
    for(let i=1;i<ROUTE.length;i++) cum.push(cum[i-1]+haversine(ROUTE[i-1], ROUTE[i]));
    totalDist = cum[cum.length-1];
    document.getElementById('statDist').textContent = fmtKm(totalDist);

    routeLine = L.polyline(ROUTE, {color:'#4f9d69', weight:3.5, opacity:0.9}).addTo(map);
    map.fitBounds(routeLine.getBounds(), {padding:[24,24]}); // zoom auto sur la zone du tracé
    startMarker = L.circleMarker(ROUTE[0], {radius:6, color:'#eef0ec', fillColor:'#4f9d69', fillOpacity:1, weight:2}).addTo(map).bindTooltip("Départ");
    endMarker = L.circleMarker(ROUTE[ROUTE.length-1], {radius:6, color:'#eef0ec', fillColor:'#d1495b', fillOpacity:1, weight:2}).addTo(map).bindTooltip("Arrivée");
  }
  
  const statusEl = document.getElementById('status');
  const listEl = document.getElementById('list');
  
  let markers = [];
  let crossings = [];
  let railSegments = null; // filled once from Overpass, [[ [lat,lon],[lat,lon] ], ...]
  
  // true 2D segment intersection (lon,lat treated as x,y — fine at this scale)
  function segIntersect(p1,p2,p3,p4){
    const x1=p1[1],y1=p1[0], x2=p2[1],y2=p2[0], x3=p3[1],y3=p3[0], x4=p4[1],y4=p4[0];
    const d1x=x2-x1, d1y=y2-y1, d2x=x4-x3, d2y=y4-y3;
    const denom = d1x*d2y - d1y*d2x;
    if (Math.abs(denom) < 1e-15) return null; // parallel
    const t = ((x3-x1)*d2y - (y3-y1)*d2x)/denom;
    const u = ((x3-x1)*d1y - (y3-y1)*d1x)/denom;
    if (t>=0 && t<=1 && u>=0 && u<=1){
      return {lat: y1+t*d1y, lon: x1+t*d1x, t};
    }
    return null;
  }
  function bbox(a,b){ return [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])]; }
  function bboxOverlap(a,b){ return a[0]<=b[2] && a[2]>=b[0] && a[1]<=b[3] && a[3]>=b[1]; }
  
  function buildRailSegments(){
    // RAIL_DATA is already track-level 2-point segments from the official SNCF Réseau shapefile
    return RAIL_DATA.map(s => ({ a: s.a, b: s.b, ligne: s.l, bbox: bbox(s.a, s.b) }));
  }
  
  function findOfficialPN(lat, lon, maxM){
    let best = null, bestD = Infinity;
    PN_DATA.forEach(pn=>{
      const d = haversine([lat,lon],[pn.lat,pn.lon]);
      if(d<bestD){ bestD=d; best=pn; }
    });
    return (best && bestD<=maxM) ? {...best, matchDist: bestD} : null;
  }

  // Recharge PN_DATA/RAIL_DATA pour la zone géographique du tracé donné (détection automatique
  // des lignes SNCF traversées, cf. commentaire en tête de fichier). allowLocalFallback ne doit
  // être vrai que pour le tracé d'origine (data/pn.json et data/rail.json sont propres à sa zone).
  async function loadDataForRoute(route, allowLocalFallback){
    const bbox = computeBBoxLatLon(route, 1000); // marge de 1 km autour du tracé
    const [pnResult, railResult] = await Promise.all([
      withFallback('PN', () => fetchPNLive(bbox), 'data/pn.json', allowLocalFallback),
      withFallback('Voies', () => fetchRailLive(bbox), 'data/rail.json', allowLocalFallback),
    ]);
    PN_DATA = pnResult.data;
    RAIL_DATA = railResult.data;
    railSegments = buildRailSegments();

    if (badgeEl) {
      badgeEl.textContent = `Source : SNCF Réseau — PN : ${pnResult.source} · Voies : ${railResult.source} · horaires : local`;
    }
    if (pnResult.source === 'indisponible' || railResult.source === 'indisponible') {
      statusEl.textContent = "⚠️ Les API SNCF Réseau n'étaient pas joignables pour cette zone : les passages à niveau affichés peuvent être incomplets ou absents. Réessaie plus tard, ou vérifie ta connexion.";
    }
  }
  
  function computeCrossings(pnMatchM){
    crossings = [];
    if(!railSegments) return;
    for(let i=1;i<ROUTE.length;i++){
      const a=ROUTE[i-1], b=ROUTE[i];
      const rbbox = bbox(a,b);
      for(const seg of railSegments){
        if(!bboxOverlap(rbbox, seg.bbox)) continue;
        const hit = segIntersect(a,b,seg.a,seg.b);
        if(hit){
          const km = cum[i-1] + hit.t*(cum[i]-cum[i-1]);
          crossings.push({lat:hit.lat, lon:hit.lon, cumMeters:km});
        }
      }
    }
    // de-duplicate crossings closer than 30m along the route (e.g. double-track lines)
    crossings.sort((x,y)=>x.cumMeters-y.cumMeters);
    const merged = [];
    crossings.forEach(c=>{
      if(merged.length && (c.cumMeters - merged[merged.length-1].cumMeters) < 30){
        return; // skip, already have one very close
      }
      merged.push(c);
    });
    // attach official PN metadata, and drop crossings with no official match
    // (no official PN nearby almost always means a bridge/tunnel, not a real level crossing)
    crossings = merged
      .map(c => ({ ...c, pn: findOfficialPN(c.lat, c.lon, pnMatchM) }))
      .filter(c => c.pn !== null);
  }
  
  // ---------- horaires temps réel (backend / API SNCF) ----------
  // Interroge le backend pour un PN donné (gare la plus proche + prochains
  // passages temps réel autour de la date/heure de la course).
  async function fetchPNSchedule(pn, dateISO, timeHHMM) {
    const url = `/api/pn-schedule?lat=${pn.lat}&lon=${pn.lon}&date=${dateISO}&time=${encodeURIComponent(timeHHMM)}`;
    try {
      return await loadJSON(url);
    } catch (err) {
      console.warn('[pn-schedule] échec pour', pn.libelle, ':', err.message);
      return { trains: [], stationName: null, distance: null, error: err.message };
    }
  }

  // Récupère en parallèle les horaires temps réel pour tous les PN du tracé
  // actuel. À appeler après computeCrossings() et avant render()/updateTimes().
  async function loadSchedulesForCrossings(dateISO, timeHHMM) {
    if (badgeEl) badgeEl.textContent = 'Interrogation des horaires SNCF temps réel…';
    await Promise.all(crossings.map(async (c) => {
      const result = await fetchPNSchedule(c.pn, dateISO, timeHHMM);
      c.trains = result.trains || [];
      c.stationInfo = { name: result.stationName, distance: result.distance, error: result.error };
    }));
    if (badgeEl) {
      badgeEl.textContent = `Source : SNCF Réseau (PN/voies) · Horaires : API SNCF temps réel`;
    }
  }

  function recomputeSummary(){
    const startMin = parseTimeToMinutes(document.getElementById('startTime').value || "14:30");
    const speed = parseFloat(document.getElementById('speed').value) || 40;
    const finishMin = totalDist/1000/speed*60;
    document.getElementById('statFinish').textContent = fmtTimeFromMinutes(startMin, finishMin);
    return {startMin, speed};
  }
  
  function render(){
    document.getElementById('statPN').textContent = crossings.length;
    markers.forEach(m=>map.removeLayer(m));
    markers = [];
    listEl.innerHTML = '';
  
    if(crossings.length===0){
      statusEl.textContent = "Aucun passage à niveau officiel confirmé sur ce tracé.";
      listEl.innerHTML = '<div class="empty">Aucun croisement géométrique route/voie ferrée n\'a de passage à niveau officiel à proximité (base SNCF Réseau). Essaie d\'augmenter le rayon de recherche ci-dessus si tu penses qu\'il en manque un.</div>';
      return;
    }
    statusEl.textContent = crossings.length + " passage(s) à niveau confirmé(s) sur le tracé.";
  
    crossings.forEach((c, idx)=>{
      const item = document.createElement('div');
      item.className = 'pn-item';
      listEl.appendChild(item);
      const marker = L.circleMarker([c.lat,c.lon], {radius:7, color:'#14171a', weight:2, fillColor:'#e2a640', fillOpacity:1}).addTo(map);
      markers.push(marker);
      marker.on('click', ()=> item.scrollIntoView({behavior:'smooth', block:'center'}));
      item.addEventListener('click', ()=>{ map.panTo([c.lat,c.lon]); marker.openPopup(); });
    });
    updateTimes();
  }
  
  function timeToMinutes(hhmm){ const [h,m]=hhmm.split(':').map(Number); return h*60+m; }
  
  function closestTrain(trains, raceMin){
    if(!trains || trains.length===0) return null;
    let best=null, bestDelta=Infinity;
    trains.forEach(tr=>{
      const tm = timeToMinutes(tr.t);
      const delta = Math.abs(tm - raceMin);
      if(delta < bestDelta){ bestDelta=delta; best={...tr, delta: tm-raceMin}; }
    });
    return best;
  }
  function riskLevel(absDeltaMin){
    if(absDeltaMin < 15) return 'watch';   // orange: under 15 min, worth a safety measure
    if(absDeltaMin < 30) return 'watchlo'; // light watch
    return 'low';
  }
  
  function updateTimes(){
    const {startMin, speed} = recomputeSummary();
    crossings.forEach((c, idx)=>{
      const addMin = (c.cumMeters/1000)/speed*60;
      const raceMin = startMin + addMin;
      const t = fmtTimeFromMinutes(startMin, addMin);
      const item = listEl.children[idx];
      const pn = c.pn;
      const lineTag = `<div class="line"></div>`;
      const metaLine = `<div class="km">km ${(c.cumMeters/1000).toFixed(1)} · ${pn.libelle}</div><div class="meta">${pn.commune || ''} · ${fmtLigne(pn.ligne)} · PK ${pn.pk}</div>`;
  
      // Les horaires viennent maintenant de l'API SNCF temps réel, récupérés pour la gare
      // la plus proche de ce PN précis (cf. loadSchedulesForCrossings / c.trains).
      const raceDate = document.getElementById('startDate').value;
      const ct = closestTrain(c.trains, raceMin);
      let trainBlock, riskClass;
      if(ct){
        const absDelta = Math.abs(ct.delta);
        riskClass = riskLevel(absDelta);
        const sign = ct.delta>=0 ? 'après' : 'avant';
        const rt = ct.realtime ? ' · temps réel' : ' · horaire théorique';
        const margin = ct.margin_min ? ` (± ${ct.margin_min} min${rt})` : rt;
        trainBlock = `<div class="train ${riskClass}">Train le plus proche : <strong>${ct.t}</strong>${margin} (${ct.type}) — ${Math.round(absDelta)} min ${sign} le passage des coureurs</div>`;
      } else if (c.stationInfo && c.stationInfo.error) {
        riskClass = 'low';
        trainBlock = `<div class="train watchlo">⚠️ Horaires indisponibles pour ce PN (${c.stationInfo.error})</div>`;
      } else {
        riskClass = 'low';
        trainBlock = `<div class="train low">Aucun train trouvé autour de l'heure de passage le ${raceDate}</div>`;
      }
      const lineInfo = LINE_TYPES[pn.ligne];
      let sourceNote;
      if (c.trains && c.trains.length && c.stationInfo && c.stationInfo.name) {
        const distKm = c.stationInfo.distance != null ? (c.stationInfo.distance/1000).toFixed(1) : '?';
        sourceNote = `Horaires temps réel API SNCF, gare la plus proche : ${c.stationInfo.name} (à ${distKm} km du PN). La marge indiquée reflète la distance entre la gare et le PN, pas une interpolation exacte.`;
      } else if (lineInfo) {
        const noTrain = lineInfo.types.length === 1 && lineInfo.types[0].startsWith('Aucun');
        sourceNote = noTrain
          ? `${lineInfo.nom} : ${lineInfo.note}`
          : `${lineInfo.nom} — desserte ${lineInfo.types.join(' + ')}. ${lineInfo.note} (horaires précis non embarqués pour cette ligne)`;
      } else {
        sourceNote = `Type de trafic non renseigné pour la ligne ${fmtLigne(pn.ligne)} (pas encore recherché) — demande-le si besoin.`;
      }
  
      item.className = 'pn-item risk-' + riskClass;
      item.innerHTML = `
        <div class="row1">
          <div class="time">${t}</div>
          ${lineTag}
        </div>
        ${metaLine}
        ${trainBlock}
        <div class="note">${sourceNote}</div>
      `;
      markers[idx].bindPopup(`<div class="popup-time">${t}</div><div class="popup-line">${fmtLigne(pn.ligne)} · PK ${pn.pk}</div><div style="font-size:12px;color:#9aa2a8">km ${(c.cumMeters/1000).toFixed(1)} · ${pn.libelle}</div>`);
    });
  }
  
  async function refreshAll(){
    const pnMatchM = parseFloat(document.getElementById('buffer').value) || 150;
    computeCrossings(pnMatchM);
    const dateISO = document.getElementById('startDate').value;
    const timeHHMM = document.getElementById('startTime').value || '14:30';
    await loadSchedulesForCrossings(dateISO, timeHHMM);
    render();
  }

  // ---------- import GPX ----------
  // Lit un fichier .gpx et en extrait les points de tracé (trkpt en priorité, puis rtept,
  // puis wpt en dernier recours). Concatène tous les segments <trkseg> à la suite : si le
  // fichier contient plusieurs segments disjoints, une ligne droite reliera leur jonction.
  function parseGPX(text){
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror')) {
      throw new Error("Fichier GPX illisible (XML invalide).");
    }
    let pts = Array.from(xml.getElementsByTagName('trkpt'));
    if (pts.length === 0) pts = Array.from(xml.getElementsByTagName('rtept'));
    if (pts.length === 0) pts = Array.from(xml.getElementsByTagName('wpt'));
    const coords = pts
      .map(p => [parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon'))])
      .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (coords.length < 2) {
      throw new Error("Aucun tracé exploitable trouvé dans ce fichier (ni trkpt, ni rtept, ni wpt).");
    }
    return coords;
  }

  const gpxInput = document.getElementById('gpxFile');
  const gpxResetBtn = document.getElementById('gpxReset');

  if (gpxInput) {
    gpxInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const points = parseGPX(reader.result);
          drawRoute(points);
          statusEl.textContent = `Tracé importé depuis "${file.name}" (${points.length} points, ${fmtKm(totalDist)}) — recherche des passages à niveau sur cette zone…`;
          await loadDataForRoute(points, false); // pas de repli local : hors zone Jard–Les Herbiers
          await refreshAll();
        } catch (err) {
          statusEl.textContent = "Erreur d'import GPX : " + err.message;
        }
        gpxInput.value = ''; // permet de réimporter le même fichier si besoin
      };
      reader.onerror = () => {
        statusEl.textContent = "Impossible de lire ce fichier.";
        gpxInput.value = '';
      };
      reader.readAsText(file);
    });
  }

  if (gpxResetBtn) {
    gpxResetBtn.disabled = !ROUTE_ORIGINAL;
    gpxResetBtn.addEventListener('click', async () => {
      if (!ROUTE_ORIGINAL) return;
      drawRoute(ROUTE_ORIGINAL);
      statusEl.textContent = "Tracé d'origine restauré — rechargement des données…";
      await loadDataForRoute(ROUTE_ORIGINAL, true);
      await refreshAll();
    });
  }

  // startTime/speed : n'affectent que le calcul local (le train le plus proche dans la
  // fenêtre déjà récupérée), pas besoin de rappeler l'API à chaque changement.
  document.getElementById('startTime').addEventListener('input', updateTimes);
  document.getElementById('speed').addEventListener('input', updateTimes);
  // buffer et startDate changent respectivement la liste des PN et la date interrogée :
  // il faut refaire un appel à l'API SNCF dans les deux cas.
  document.getElementById('buffer').addEventListener('input', refreshAll);
  document.getElementById('startDate').addEventListener('input', refreshAll);

  drawRoute(ROUTE);
  recomputeSummary();
  if (ROUTE.length) {
    statusEl.textContent = "Recherche des passages à niveau et voies ferrées sur cette zone (SNCF Réseau)…";
    await loadDataForRoute(ROUTE, true);
    await refreshAll();
  } else {
    statusEl.textContent = "Importez un fichier GPX pour commencer.";
  }
}

init().catch(err => {
  console.error(err);
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = "Erreur de chargement des données : " + err.message;
});
