#!/usr/bin/env node
/**
 * test-kmeans.js - the spectrometer bake's codebook k-means
 * (public/spectrometer-bake.js `kmeans`) stops once a pass changes no label and
 * leaves no cluster empty, and that early stop changes nothing: codebook and
 * labels are byte-identical to running every iteration. The reference below is
 * the loop without the early stop.
 *
 * Pure JS: no WASM, no browser, no SID. Run with `node scripts/test-kmeans.js`
 * (`--bench` also times both on bake-sized inputs).
 */

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// kmeans as it ran before the early stop: every one of `iters` passes.
function kmeansFull(data, numRows, dim, K, iters, seed, snap) {
    const rng = mulberry32(seed);
    const cent = new Float64Array(K * dim);
    const first = Math.floor(rng() * numRows);
    for (let d = 0; d < dim; d++) cent[d] = data[first * dim + d];
    const dist = new Float64Array(numRows).fill(Infinity);
    for (let c = 1; c < K; c++) {
        let total = 0;
        for (let r = 0; r < numRows; r++) {
            let dd = 0;
            for (let d = 0; d < dim; d++) { const df = data[r * dim + d] - cent[(c - 1) * dim + d]; dd += df * df; }
            if (dd < dist[r]) dist[r] = dd;
            total += dist[r];
        }
        let pick = rng() * total, idx = 0;
        for (; idx < numRows; idx++) { pick -= dist[idx]; if (pick <= 0) break; }
        if (idx >= numRows) idx = numRows - 1;
        for (let d = 0; d < dim; d++) cent[c * dim + d] = data[idx * dim + d];
    }
    const labels = new Uint8Array(numRows);
    const sums = new Float64Array(K * dim);
    const counts = new Int32Array(K);
    for (let it = 0; it < iters; it++) {
        sums.fill(0); counts.fill(0);
        for (let r = 0; r < numRows; r++) {
            let best = 0, bestD = Infinity;
            for (let c = 0; c < K; c++) {
                let dd = 0;
                for (let d = 0; d < dim; d++) { const df = data[r * dim + d] - cent[c * dim + d]; dd += df * df; if (dd >= bestD) break; }
                if (dd < bestD) { bestD = dd; best = c; }
            }
            labels[r] = best; counts[best]++;
            const off = best * dim, ro = r * dim;
            for (let d = 0; d < dim; d++) sums[off + d] += data[ro + d];
        }
        for (let c = 0; c < K; c++) {
            if (counts[c] === 0) {
                const r = Math.floor(rng() * numRows);
                for (let d = 0; d < dim; d++) cent[c * dim + d] = data[r * dim + d];
            } else {
                for (let d = 0; d < dim; d++) cent[c * dim + d] = sums[c * dim + d] / counts[c];
            }
        }
    }
    const codebook = new Uint8Array(K * dim);
    for (let i = 0; i < K * dim; i++) {
        const v = Math.max(0, Math.min(255, Math.round(cent[i])));
        codebook[i] = snap ? snap(v) : v;
    }
    for (let r = 0; r < numRows; r++) {
        let best = 0, bestD = Infinity;
        for (let c = 0; c < K; c++) {
            let dd = 0;
            for (let d = 0; d < dim; d++) { const df = data[r * dim + d] - codebook[c * dim + d]; dd += df * df; }
            if (dd < bestD) { bestD = dd; best = c; }
        }
        labels[r] = best;
    }
    return { codebook, labels };
}

// Bar-height-like rows: `shapes` prototypes, each row one of them plus noise,
// held for a few rows at a time the way keyframes repeat.
function rows(numRows, dim, shapes, noise, seed) {
    const rng = mulberry32(seed);
    const protos = Array.from({ length: shapes }, () => Array.from({ length: dim }, () => Math.floor(rng() * 200)));
    const out = new Uint8Array(numRows * dim);
    let p = 0;
    for (let r = 0; r < numRows; r++) {
        if (rng() < 0.3) p = Math.floor(rng() * shapes);
        for (let d = 0; d < dim; d++) {
            out[r * dim + d] = Math.max(0, Math.min(255, protos[p][d] + Math.round((rng() - 0.5) * 2 * noise)));
        }
    }
    return out;
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const snap2 = (v) => Math.min(255, Math.round(v / 2) * 2);

(async () => {
    const { _internals } = await import('../public/spectrometer-bake.js');
    const { kmeans } = _internals;

    const cases = [
        { name: 'clustered, 1,500 x 8', numRows: 1500, dim: 8, shapes: 40, noise: 6 },
        { name: 'noisy, 2,000 x 8', numRows: 2000, dim: 8, shapes: 400, noise: 30 },
        { name: 'few rows, 300 x 8', numRows: 300, dim: 8, shapes: 20, noise: 4 },
        { name: 'eight distinct rows, 1,000 x 4 (clusters stay empty)', numRows: 1000, dim: 4, shapes: 8, noise: 0 },
    ];
    let stoppedEarly = 0;
    for (const c of cases) {
        console.log(c.name);
        for (const seed of [1, 0x1234]) {
            for (const snap of [null, snap2]) {
                const data = rows(c.numRows, c.dim, c.shapes, c.noise, seed * 7 + 3);
                let ticks = 0;
                const got = await kmeans(data, c.numRows, c.dim, 256, 30, seed, () => { ticks++; }, snap);
                const want = kmeansFull(data, c.numRows, c.dim, 256, 30, seed, snap);
                check(same(got.codebook, want.codebook) && same(got.labels, want.labels),
                    `seed ${seed}${snap ? ', snapped' : ''}: identical to every iteration`, `${ticks} pass(es)`);
                if (ticks < 30) stoppedEarly++;
            }
        }
    }
    check(stoppedEarly > 0, 'converged inputs stop before the last iteration', `${stoppedEarly} run(s)`);

    if (process.argv.includes('--bench')) {
        console.log('timing (K = 256, 30 iterations, codebook step 2)');
        for (const [numRows, dim] of [[3686, 8], [18000, 40]]) {
            const data = rows(numRows, dim, 600, 12, 99);
            let t = performance.now();
            kmeansFull(data, numRows, dim, 256, 30, 5, snap2);
            const full = performance.now() - t;
            let ticks = 0;
            t = performance.now();
            await kmeans(data, numRows, dim, 256, 30, 5, () => { ticks++; }, snap2);
            const early = performance.now() - t;
            console.log(`  ${numRows} x ${dim}: every iteration ${full.toFixed(0)} ms, early stop ${early.toFixed(0)} ms (${ticks} passes)`);
        }
    }

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
