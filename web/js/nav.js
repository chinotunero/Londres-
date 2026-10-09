// Turn-by-turn navigation: follows GPS fixes along a planned journey, announces turns and stops,
// detects when the walker leaves the route and asks for a new walking path.

const RAD = Math.PI / 180;
function local(lat) { return { kx: Math.cos(lat * RAD) * 111320, ky: 110574 }; }

// Project a point onto a polyline of [lon, lat] with cumulative distances `cum`.
// Searches segments [i0, i1). Returns {along, off, seg}.
export function project(coords, cum, lat, lon, i0 = 0, i1 = coords.length - 1) {
  const { kx, ky } = local(lat);
  let best = { along: 0, off: Infinity, seg: 0 };
  for (let i = Math.max(0, i0); i < Math.min(i1, coords.length - 1); i++) {
    const ax = (coords[i][0] - lon) * kx, ay = (coords[i][1] - lat) * ky;
    const bx = (coords[i + 1][0] - lon) * kx, by = (coords[i + 1][1] - lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.off) best = { along: cum[i] + t * (cum[i + 1] - cum[i]), off, seg: i };
  }
  return best;
}
export function cumulative(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const { kx, ky } = local(coords[i][1]);
    cum.push(cum[i - 1] + Math.hypot((coords[i][0] - coords[i - 1][0]) * kx, (coords[i][1] - coords[i - 1][1]) * ky));
  }
  return cum;
}
const round10 = (m) => (m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

export function rideTitle(leg) {
  if (leg.mode === "bus" || leg.mode === "trolleybus") return `autobús ${leg.ref || leg.label}`;
  return leg.label;
}

export class Navigator {
  constructor(journey, cb) {
    this.j = journey;
    this.cb = cb; // {update(state), speak(text, urgent), reroute(legIndex, pos), done()}
    this.i = 0;
    for (const leg of this.j.legs) this.prepareLeg(leg);
  }
  prepareLeg(leg) {
    if (!leg.cum || leg.cum.length !== leg.coords.length) leg.cum = cumulative(leg.coords);
    leg.total = leg.cum[leg.cum.length - 1] || 0;
    if (leg.type === "ride") leg.stopAlong = leg.stops.map((s) => project(leg.coords, leg.cum, s.lat, s.lon).along);
    leg._state = { k: 0, pre: new Set(), now: new Set(), along: 0, seg: 0, phase: "wait", lastStop: 0, offCount: 0 };
  }
  get leg() { return this.j.legs[this.i]; }
  start() { this.legStartTime = Date.now(); this.announceLeg(); this.emit(); }
  stop() { this.stopped = true; }

  announceLeg() {
    const leg = this.leg;
    if (!leg) return;
    if (leg.type === "walk") {
      const next = this.j.legs[this.i + 1];
      const target = next && next.type === "ride" && leg.entrance ? `la ${leg.entrance} de ${leg.to}` : leg.to;
      const first = leg.maneuvers[0];
      this.cb.speak(`${first ? first.text + ". " : ""}Camina ${round10(leg.total)} metros hasta ${target || "tu destino"}.`, true);
      if (first) leg._state.now.add(0);
    } else {
      const bus = leg.mode === "bus" || leg.mode === "trolleybus";
      const where = bus ? `la parada ${leg.from.name}${leg.from.ref ? ", " + leg.from.ref : ""}` : `el andén de ${leg.label} en ${leg.from.name}`;
      this.cb.speak(`Ve a ${where}. Toma el ${rideTitle(leg)} hacia ${leg.headsign}. Bájate en ${leg.to.name}, dentro de ${leg.nStops} ${leg.nStops === 1 ? "parada" : "paradas"}.`, true);
    }
  }

  next() { // advance to the following leg (automatic, or the "Siguiente" button)
    if (this.i < this.j.legs.length - 1) {
      this.i++;
      this.legStartTime = Date.now();
      this.announceLeg();
      this.emit();
    } else if (!this.finished) {
      this.finished = true;
      this.cb.speak("Has llegado a tu destino.", true);
      this.emit();
      if (this.cb.done) this.cb.done();
    }
  }

  replaceLeg(index, leg) {
    this.prepareLeg(leg);
    leg._state.now.add(0);
    this.j.legs[index] = leg;
    this.rerouting = false;
    this.cb.speak(leg.maneuvers[0] ? `Ruta recalculada. ${leg.maneuvers[0].text}.` : "Ruta recalculada.", true);
    this.emit();
  }

  position(p) {
    if (this.stopped || this.finished) return;
    this.pos = p;
    const leg = this.leg;
    const st = leg._state;
    if (leg.type === "walk") {
      let pr = project(leg.coords, leg.cum, p.lat, p.lon, st.seg - 3, st.seg + 40);
      if (pr.off > 25) pr = project(leg.coords, leg.cum, p.lat, p.lon);
      const tol = Math.max(30, Math.min(80, (p.acc || 20) * 1.3));
      if (pr.off > tol) {
        st.offCount++;
        if (st.offCount >= 3 && !this.rerouting && (!this.lastReroute || Date.now() - this.lastReroute > 12000)) {
          this.rerouting = true;
          this.lastReroute = Date.now();
          this.cb.speak("Te has salido de la ruta. Recalculando.", true);
          this.cb.reroute(this.i, p);
        }
      } else {
        st.offCount = 0;
        if (pr.along >= st.along - 25) { st.along = Math.max(st.along, pr.along); st.seg = pr.seg; }
      }
      const mans = leg.maneuvers;
      while (st.k < mans.length - 1 && mans[st.k].d <= st.along + 4) st.k++;
      const m = mans[st.k];
      if (m) {
        const dist = m.d - st.along;
        if (m.type !== "arrive" && dist <= 45 && dist > 16 && !st.pre.has(st.k)) {
          st.pre.add(st.k);
          this.cb.speak(`En ${round10(dist)} metros, ${lowerFirst(m.text)}.`);
        }
        if (dist <= 14 && !st.now.has(st.k)) {
          st.now.add(st.k);
          if (m.type !== "arrive") {
            this.cb.speak(m.text + ".", true);
            if (navigator.vibrate) navigator.vibrate(m.type === "left" || m.type === "right" ? [80, 60, 80] : 60);
          }
        }
      }
      const endPt = leg.coords[leg.coords.length - 1];
      const { kx, ky } = local(p.lat);
      const toEnd = Math.hypot((endPt[0] - p.lon) * kx, (endPt[1] - p.lat) * ky);
      if (st.along >= leg.total - 12 || (toEnd < 15 && st.along > leg.total * 0.6)) { this.next(); return; }
    } else {
      const pr = project(leg.coords, leg.cum, p.lat, p.lon);
      if (pr.off < 120) {
        if (st.phase === "wait" && (pr.along > 150 || (pr.along > 60 && (p.speed || 0) > 3))) {
          st.phase = "ride";
          this.cb.speak(`Vas en el ${rideTitle(leg)}. Bájate en ${leg.to.name}.`);
        }
        if (st.phase === "ride") {
          st.along = Math.max(st.along, pr.along);
          let passed = 0;
          for (let s = 0; s < leg.stopAlong.length; s++) if (leg.stopAlong[s] <= st.along + 40) passed = s;
          if (passed !== st.lastStop) {
            st.lastStop = passed;
            const left = leg.stops.length - 1 - passed;
            if (left === 1) this.cb.speak(`Próxima parada: ${leg.to.name}. Prepárate para bajar.`, true);
            else if (left > 1 && left <= 3) this.cb.speak(`Quedan ${left} paradas.`);
          }
          if (st.along >= leg.total - 50) {
            this.cb.speak(`Bájate aquí: ${leg.to.name}.`, true);
            if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
            this.next();
            return;
          }
        }
      }
      // GPS comes back near the alighting stop after an underground ride
      const { kx, ky } = local(p.lat);
      const toStop = Math.hypot((leg.to.lon - p.lon) * kx, (leg.to.lat - p.lat) * ky);
      if (toStop < 120 && (st.phase === "ride" || Date.now() - this.legStartTime > 60000 * Math.max(2, leg.ride * 0.6))) { this.next(); return; }
    }
    this.emit();
  }

  remaining() {
    let min = 0, m = 0;
    this.j.legs.forEach((l, i) => {
      if (i < this.i) return;
      if (i === this.i) {
        const done = l.total ? Math.min(1, l._state.along / l.total) : 0;
        min += l.type === "walk" ? l.min * (1 - done) : (l._state.phase === "ride" ? l.ride * (1 - done) : l.min);
        m += (l.total || 0) * (1 - done);
      } else { min += l.min; m += l.total || 0; }
    });
    return { min, m };
  }

  state() {
    const leg = this.leg, st = leg._state;
    const s = { index: this.i, count: this.j.legs.length, leg, finished: !!this.finished, rerouting: !!this.rerouting, ...this.remaining() };
    if (leg.type === "walk") {
      const mans = leg.maneuvers;
      let m = mans[st.k] || mans[mans.length - 1];
      if (st.k === 0 && mans[1]) m = mans[1];
      s.kind = "walk";
      s.icon = m.type;
      s.dist = Math.max(0, m.d - st.along);
      s.text = m.text;
      s.sub = m.type === "arrive" ? "" : (m.street ? m.street : leg.to ? "hacia " + leg.to : "");
      s.offRoute = st.offCount > 0;
    } else {
      const left = leg.stops.length - 1 - st.lastStop;
      s.kind = st.phase === "ride" ? "ride" : "wait";
      s.stopsLeft = left;
      s.icon = "ride";
      s.text = st.phase === "ride" ? `Bájate en ${leg.to.name}` : `Toma el ${rideTitle(leg)}`;
      s.sub = st.phase === "ride" ? `${left} ${left === 1 ? "parada" : "paradas"} · ${leg.label} hacia ${leg.headsign}`
        : `hacia ${leg.headsign} · en ${leg.from.name}${leg.from.ref ? " (" + leg.from.ref + ")" : ""} · cada ~${leg.headway} min`;
    }
    return s;
  }
  emit() { if (this.cb.update) this.cb.update(this.state()); }
}
