#!/usr/bin/env node
/**
 * test-range-fit.js - the per-song frequency range of the baked spectrometer.
 *
 * bakeSpectrometer (public/spectrometer-bake.js) fits the span its 40 bars
 * cover to the part of the spectrum the tune actually uses, read off the fine
 * semitone grid the analyser keeps next to the fixed bars. These checks feed
 * it synthetic audio with known content and confirm: the fitted span brackets
 * the tones and leaves out the octaves above them; a narrow tune is widened to
 * the minimum span rather than given bars the FFT cannot resolve; the fixed
 * grid the loop detection measures on is untouched by the fit; the bars
 * derived from the fine grid agree with the ones computed straight from the
 * bins over the same span; and silence keeps the fixed span.
 *
 * Pure JS: no WASM, no browser, no SID. Run with `node scripts/test-range-fit.js`.
 */

const SR = 44100;
const FRAME_HZ = 50;

let failures = 0;
function check(ok, what, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

// `seconds` of the given tones, each amplitude 0..1, with a little noise on
// top so no band is ever exactly zero.
function tones(seconds, list, noise = 0.0005) {
    const n = Math.floor(seconds * SR);
    const pcm = new Float32Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) {
        let v = 0;
        for (const [hz, amp] of list) v += amp * Math.sin(2 * Math.PI * hz * i / SR);
        s = (s * 1664525 + 1013904223) >>> 0;
        pcm[i] = v + noise * (s / 0x80000000 - 1);
    }
    return pcm;
}

(async () => {
    const bake = await import('../public/spectrometer-bake.js');
    const { computeRowStore, whitenQuantize, outputStore, DEFAULTS, FIT_MIN_OCTAVES } = bake._internals;
    const opts = { frameHz: FRAME_HZ, maxSeconds: 60, minLoopSeconds: 2, kmeansIters: 2 };

    // --- a tune with content from 100 Hz to 2 kHz -------------------------------
    const mid = await bake.bakeSpectrometer(tones(8, [[110, 0.4], [440, 0.3], [1760, 0.2]]), SR, opts);
    check(mid.rangeFitted, 'the range is fitted from the fine grid');
    check(mid.fMin <= 110 && mid.fMin > 60,
        'the bottom of the span sits just under the lowest tone', `${mid.fMin.toFixed(0)} Hz`);
    check(mid.fMax >= 1760 && mid.fMax < 4000,
        'the top sits just over the highest tone, not at the fixed ceiling', `${mid.fMax.toFixed(0)} Hz`);

    // --- a narrow tune is widened to the minimum span, upward ------------------
    const narrow = await bake.bakeSpectrometer(tones(8, [[200, 0.4], [300, 0.3]]), SR, opts);
    const octaves = Math.log2(narrow.fMax / narrow.fMin);
    check(octaves >= FIT_MIN_OCTAVES - 1e-9 && octaves < FIT_MIN_OCTAVES + 0.2,
        'two close tones are given the minimum span', `${narrow.fMin.toFixed(0)}..${narrow.fMax.toFixed(0)} Hz`);
    check(narrow.fMin <= 200 && narrow.fMin > 100, 'widened upward from the tones, not around them',
        `${narrow.fMin.toFixed(0)} Hz`);

    // --- noise drums push the top up ------------------------------------------
    // A dense comb of partials from 6 to 9 kHz stands in for a noise drum: it
    // fills its bands the way noise does, which a lone sine in a 400 Hz wide
    // band at that height would not.
    const comb = [[110, 0.4]];
    for (let hz = 6000; hz <= 9000; hz += 40) comb.push([hz, 0.02]);
    const bright = await bake.bakeSpectrometer(tones(8, comb), SR, opts);
    check(bright.fMax >= 9000 && bright.fMax < 12000,
        'content above the old 5.5 kHz ceiling extends the span', `${bright.fMax.toFixed(0)} Hz`);

    // --- silence keeps the fixed span -----------------------------------------
    const quiet = await bake.bakeSpectrometer(new Float32Array(SR * 6), SR, opts);
    check(!quiet.rangeFitted && quiet.fMin === DEFAULTS.fMin && quiet.fMax === DEFAULTS.fMax,
        'a silent render keeps the fixed span', `${quiet.fMin}..${quiet.fMax} Hz`);

    // --- the fit never touches what the loop detection measures on -------------
    const pcm = tones(8, [[110, 0.4], [440, 0.3], [1760, 0.2]]);
    const store = await computeRowStore(pcm, SR, 40, FRAME_HZ);
    const fixed = whitenQuantize(store, 111, 1, store.count);
    const o = { ...DEFAULTS, frameHz: FRAME_HZ };
    const fitted = outputStore(store, o);
    const again = whitenQuantize(store, 111, 1, store.count);
    check(fixed.every((v, i) => v === again[i]) && fitted.out !== store,
        'the fixed grid is unchanged by deriving the fitted one');

    // --- derived bars agree with bars computed straight from the bins ----------
    // Over the FIXED span the two should describe the same spectrum where they
    // read the same window: above the pitch the 4096-point window resolves a
    // bar at, the fine grid re-bins the same bytes, so the whitened, quantized
    // columns must sit within a couple of units of each other on the 0..111
    // scale. (Below it the fine grid reads the longer windows, which is the
    // point of them, so those bars are not expected to match.)
    const derived = outputStore(store, { ...o, fitRange: false });
    check(derived.out === store, 'with fitting off the fixed grid is stored as-is');
    const { deriveBars, analysisSources } = bake._internals;
    const same = deriveBars(store.fine, 40, DEFAULTS.fMin, DEFAULTS.fMax);
    const a = whitenQuantize(store, 111, 1, store.count), b = whitenQuantize(same, 111, 1, same.count);
    const shortFrom = analysisSources(SR)[0].resolvesFrom;
    const firstBar = Math.ceil(40 * Math.log(shortFrom / DEFAULTS.fMin) / Math.log(DEFAULTS.fMax / DEFAULTS.fMin));
    let sum = 0, n = 0;
    for (let k = 0; k < store.count; k++)
        for (let x = firstBar; x < 40; x++) { sum += Math.abs(a[k * 40 + x] - b[k * 40 + x]); n++; }
    check(sum / n < 3, 'bars derived from the fine grid match the direct ones where they share a window',
        `bars ${firstBar}..39, mean |diff| ${(sum / n).toFixed(2)}`);

    // --- the bass end resolves notes the short window blurs together ------------
    // Two bass notes four semitones apart, read as RAW rows (whitening flattens
    // any static spectrum, so the peaks have to be looked at before it): on
    // the fine grid's long window they are two peaks with a dip between; on the
    // fixed grid's 4096-point window alone they are one block.
    const bassStore = await computeRowStore(tones(8, [[55, 0.4], [69, 0.4], [880, 0.1]]), SR, 40, FRAME_HZ);
    const fine = outputStore(bassStore, o);
    const frame = Math.floor(bassStore.count / 2);
    const peaksAndDip = (st, fMin, fMax) => {
        const barOf = (hz) => Math.floor(40 * Math.log(hz / fMin) / Math.log(fMax / fMin));
        const rowAt = st.data.subarray(frame * 40, frame * 40 + 40);
        const b55 = barOf(55), b69 = barOf(69);
        let dip = 1;
        for (let x = b55 + 1; x < b69; x++) dip = Math.min(dip, rowAt[x]);
        return { b55, b69, p55: rowAt[b55], p69: rowAt[b69], dip };
    };
    const onFine = peaksAndDip(fine.out, fine.fMin, fine.fMax);
    check(onFine.b69 > onFine.b55 + 1 && onFine.dip < 0.8 * Math.min(onFine.p55, onFine.p69),
        'two bass notes a few bars apart are two peaks on the fine grid',
        `bars ${onFine.b55}/${onFine.b69}: ${onFine.p55.toFixed(2)} / ${onFine.dip.toFixed(2)} / ${onFine.p69.toFixed(2)}`);
    const onFixed = peaksAndDip(bassStore, DEFAULTS.fMin, DEFAULTS.fMax);
    check(onFixed.dip > 0.9 * Math.min(onFixed.p55, onFixed.p69),
        'which the 4096-point window alone blurs into one block',
        `bars ${onFixed.b55}/${onFixed.b69}: ${onFixed.p55.toFixed(2)} / ${onFixed.dip.toFixed(2)} / ${onFixed.p69.toFixed(2)}`);

    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
