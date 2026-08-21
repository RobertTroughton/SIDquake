// prg-builder.js - Assembles C64 PRG files from SID music, a data block,
// optional save/restore routines, and a visualizer binary with its inputs.

/**
 * PRGBuilder collects independently-loaded components (each with its own
 * load address) and emits a single contiguous .prg image. Gaps between
 * components are zero-filled. The output begins with the standard 2-byte
 * little-endian load address header that C64 LOAD expects.
 */
class PRGBuilder {
    constructor() {
        this.components = [];
        this.lowestAddress = 0xFFFF;
        this.highestAddress = 0x0000;
    }

    addComponent(data, loadAddress, name, priority = 0, hidden = false) {
        if (!data || data.length === 0) {
            throw new Error(`Component ${name} has no data`);
        }
        // A component that runs past $FFFF - or a NaN address from a missing
        // config field - would otherwise size the PRG from a bogus highest
        // address and drop the overhanging bytes on the floor at build().
        if (!Number.isInteger(loadAddress) || loadAddress < 0 || loadAddress + data.length > 0x10000) {
            throw new Error(`Component ${name} (${data.length} bytes at ` +
                `${Number.isInteger(loadAddress) ? '$' + loadAddress.toString(16).toUpperCase() : loadAddress}) ` +
                `does not fit in C64 memory`);
        }

        this.components.push({
            data: data,
            loadAddress: loadAddress,
            size: data.length,
            name: name,
            // Write layer: base binary/graphics = 0, user inputs (logo/bitmap) = 1,
            // option patches = 2. Higher layers are written last so they win over
            // any lower-layer bytes they overlap, regardless of load address. This
            // is what lets a large bitmap-logo input override the base graphics
            // blob that the memory-map split emits as a separate higher-address
            // component (which would otherwise be written after, and clobber, the
            // logo's lower rows).
            priority: priority,
            // Placed in the PRG but omitted from the memory map. Used for input
            // sub-regions (a logo's screen/colour copies) that just fill a base
            // graphics region already labelled by role - showing them too would
            // duplicate that region under a variable-ish name.
            hidden: hidden
        });

        this.lowestAddress = Math.min(this.lowestAddress, loadAddress);
        this.highestAddress = Math.max(this.highestAddress, loadAddress + data.length - 1);
    }

    build() {
        if (this.components.length === 0) {
            throw new Error('No components added to PRG');
        }

        // Write order: lower priority first so higher-priority components (user
        // inputs, then option patches) are written last and win over any base
        // bytes they overlap - even when the base component sits at a HIGHER load
        // address (e.g. the split graphics blob's "charset + bar chars" part above
        // a bitmap logo). Within a priority, sort by load address ascending, and at
        // the same address emit larger components first so smaller patches
        // (e.g. single-byte option values) are written last and override.
        this.components.sort((a, b) => {
            if ((a.priority || 0) !== (b.priority || 0)) {
                return (a.priority || 0) - (b.priority || 0);
            }
            if (a.loadAddress !== b.loadAddress) {
                return a.loadAddress - b.loadAddress;
            }
            return b.size - a.size;
        });

        const totalSize = (this.highestAddress - this.lowestAddress + 1) + 2;
        const prgData = new Uint8Array(totalSize);

        prgData[0] = this.lowestAddress & 0xFF;
        prgData[1] = (this.lowestAddress >> 8) & 0xFF;

        for (let i = 2; i < totalSize; i++) {
            prgData[i] = 0x00;
        }

        for (const component of this.components) {
            const offset = component.loadAddress - this.lowestAddress + 2;
            for (let i = 0; i < component.data.length; i++) {
                prgData[offset + i] = component.data[i];
            }
        }

        return prgData;
    }

    clear() {
        this.components = [];
        this.lowestAddress = 0xFFFF;
        this.highestAddress = 0x0000;
    }

    getInfo() {
        return {
            components: this.components.map(c => ({
                name: c.name,
                loadAddress: c.loadAddress,
                size: c.size,
                endAddress: c.loadAddress + c.size - 1,
                priority: c.priority || 0,
                hidden: !!c.hidden
            })),
            lowestAddress: this.lowestAddress,
            highestAddress: this.highestAddress,
            totalSize: this.highestAddress - this.lowestAddress + 1
        };
    }
}

/**
 * SIDquakePRGExporter orchestrates the full export: it pulls the modified
 * SID out of the analyzer, generates self-modifying save/restore routines for
 * any memory the SID touches, places them in free memory, layers in the
 * selected visualizer with its option/input components, and produces a
 * (optionally compressed) C64 .prg.
 */
class SIDquakePRGExporter {
    constructor(analyzer) {
        this.analyzer = analyzer;
        this.builder = new PRGBuilder();
        this.compressorManager = new CompressorManager();
        this.saveRoutineAddress = 0;
        this.restoreRoutineAddress = 0;
    }

    // Round up to the next page ($100) boundary. NOT `(address + 0xFF) & 0xFF00`:
    // that masks to 16 bits, so any address above $FF00 wraps to $0000 (e.g.
    // $FF80 -> $0000) and a fit check downstream would then happily "place" a
    // routine in zero page. Here $FF01..$FFFF round up to $10000, which is above
    // every usable-RAM limit the callers test against, so they correctly reject
    // it instead of wrapping.
    alignToPage(address) {
        return Math.ceil(address / 0x100) * 0x100;
    }

    /**
     * Find a page-aligned location with at least routineSize free bytes that
     * doesn't collide with any component already added to the builder, and
     * doesn't fall inside the I/O area at $D000-$DFFF.
     * @param {number} routineSize - Combined size of save+restore routines
     * @returns {number} Page-aligned address suitable for the routines
     */
    /**
     * Choose the high byte of a 1K screen page in VIC bank 0 ($0000-$3FFF) for
     * the "Linked With" intro that doesn't collide with anything already placed
     * (most importantly a SID that loads low). Skips the zero page/stack/system
     * area ($0000-$03FF) and the character-ROM shadow ($1000-$1FFF, where the
     * VIC cannot use RAM as a screen). Legacy players relocate the intro screen
     * onto this page via the data block; bank-aware players ignore it.
     * @returns {number} High byte of the chosen page (e.g. 0x04 for $0400)
     */
    computeIntroScreenHi() {
        const candidates = [0x04, 0x08, 0x0c, 0x20, 0x24, 0x28, 0x2c, 0x30, 0x34, 0x38, 0x3c];
        for (const hi of candidates) {
            const blockStart = hi << 8;
            const blockEnd = blockStart + 0x3ff;
            let clash = false;
            for (const comp of this.builder.components) {
                const cs = comp.loadAddress;
                const ce = comp.loadAddress + comp.size - 1;
                if (!(blockEnd < cs || blockStart > ce)) {
                    clash = true;
                    break;
                }
            }
            if (!clash) return hi;
        }
        return 0x04; // best effort if bank 0 is unusually full
    }

    // align (default true): page-align the returned address. Most placements want
    // this, but data read with indexed-absolute addressing (e.g. the spectrometer
    // index stream) works at any alignment, so passing align=false lets it start
    // right after the previous region instead of paying up to 255 bytes of pad.
    findSafeMemoryForRoutines(routineSize, sidLoadAddress, sidDataLength, reservedRanges = [], align = true) {
        const usedRanges = [];
        const alignStart = (addr) => align ? this.alignToPage(addr) : addr;

        for (const comp of this.builder.components) {
            usedRanges.push({
                start: comp.loadAddress,
                end: comp.loadAddress + comp.size
            });
        }

        // Reserve extra ranges (e.g. the intro screen page) so routines avoid them
        for (const range of reservedRanges) {
            usedRanges.push({ start: range.start, end: range.end });
        }

        // I/O area is always considered used so we don't try to place code there
        usedRanges.push({ start: 0xD000, end: 0xE000 });

        usedRanges.sort((a, b) => a.start - b.start);

        // Start searching at $0900 to skip zero page, stack, system vectors,
        // and the default screen RAM at $0400-$07FF.
        let prevEnd = 0x0900;

        for (const range of usedRanges) {
            if (range.end <= prevEnd) continue;

            const gapStart = prevEnd;
            const gapEnd = range.start;

            if (gapStart >= 0xD000 && gapStart < 0xE000) {
                prevEnd = Math.max(prevEnd, range.end);
                continue;
            }

            // Clamp the gap so it never crosses into the I/O hole.
            // Align first, then check the fit: page alignment can consume up
            // to 255 bytes of the gap, so testing the raw gap size could
            // return an address whose routines overlap the next component.
            const effectiveGapEnd = Math.min(gapEnd, 0xD000);
            const alignedStart = alignStart(gapStart);

            if (alignedStart + routineSize <= effectiveGapEnd) {
                return alignedStart;
            }

            prevEnd = Math.max(prevEnd, range.end);
        }

        // Try the gap above the highest used range but still below I/O
        if (prevEnd < 0xD000) {
            const alignedStart = alignStart(prevEnd);
            if (alignedStart + routineSize <= 0xD000) {
                return alignedStart;
            }
        }

        // Try the area above the I/O hole, stopping short of the $FFFA-$FFFF CPU
        // vectors: with the player's $01=$35 config the 6510 fetches IRQ/NMI/RESET
        // vectors from RAM there, so a routine overlapping them bricks the export.
        // (Matches the $FFFA cap in largestFreeCpuBlock and the reloc viable() checks.)
        const afterIO = alignStart(Math.max(prevEnd, 0xE000));
        if (afterIO + routineSize <= 0xFFFA) {
            return afterIO;
        }

        // Nothing fits. Return null so callers fail loudly (or skip a candidate
        // bank) rather than silently overwriting code/data - the old $0900
        // fallback landed routines on top of a low-loading tune's music.
        console.warn(`Could not find ${routineSize} bytes of free RAM for save/restore routines`);
        return null;
    }

    // Largest contiguous run of free CPU-visible RAM (bytes), given [start,end)
    // reserved ranges. The baked codebook/index are read by the CPU every frame,
    // so they must live in RAM the CPU can see with the player's $01=$35 config:
    // $0900-$CFFF (below I/O) and $E000-$FFF9 (under the banked-out KERNAL, kept
    // clear of the $FFFA CPU vectors). Used to compare candidate graphics banks.
    largestFreeCpuBlock(reserved) {
        let best = 0;
        for (const [lo, hi] of [[0x0900, 0xD000], [0xE000, 0xFFFA]]) {  // [lo, hi) half-open
            const cuts = reserved
                .map(r => [Math.max(r.start, lo), Math.min(r.end, hi)])
                .filter(([s, e]) => e > s)
                .sort((a, b) => a[0] - b[0]);
            let cursor = lo;
            for (const [s, e] of cuts) {
                if (s > cursor) best = Math.max(best, s - cursor);
                cursor = Math.max(cursor, e);
            }
            if (hi > cursor) best = Math.max(best, hi - cursor);
        }
        return best;
    }

    // Which of the tune's modified addresses the save/restore routines actually
    // snapshot. Excludes the stack ($0100-$01FF - the player owns it) and the
    // WHOLE I/O window ($D000-$DFFF). Saving hardware registers is wrong, not
    // just pointless: e.g. the save would LDA $DC04 (the live CIA down-counter,
    // not what the tune wrote) and restore would poke that random value back
    // into the timer latch on real hardware. Covers SID ($D400-$D7FF), VIC, CIA
    // and colour RAM alike. The three call sites MUST agree - hence one helper.
    _isSaveRestorable(addr) {
        if (addr >= 0x0100 && addr <= 0x01FF) return false;
        if (addr >= 0xD000 && addr <= 0xDFFF) return false;
        return true;
    }

    calculateSaveRestoreSize(modifiedAddresses) {
        const filtered = modifiedAddresses.filter(addr => this._isSaveRestorable(addr));

        let saveSize = 1; // RTS
        let restoreSize = 1; // RTS
        for (const addr of filtered) {
            if (addr < 256) {
                saveSize += 5; // Save: LDA zp (2) + STA abs (3) = 5
                restoreSize += 4; // Restore: LDA # (2) + STA zp (2) = 4
            } else {
                saveSize += 6; // Save: LDA abs (3) + STA abs (3) = 6
                restoreSize += 5; // Restore: LDA # (2) + STA abs (3) = 5
            }
        }

        return {
            saveSize,
            restoreSize,
            totalSize: saveSize + restoreSize,
            addressCount: filtered.length
        };
    }

    // Save/restore table size, or 0 when this player/tune doesn't need one.
    _saveRestoreSizeFor(vizConfig, modifiedAddresses) {
        return (vizConfig.needsSaveRestore && modifiedAddresses)
            ? this.calculateSaveRestoreSize(modifiedAddresses).totalSize : 0;
    }

    selectValidLayouts(vizConfig, sidLoadAddress, sidSize, modifiedAddresses = null) {
        const validLayouts = [];

        // The SID data range - save/restore routines are placed separately in free memory
        let effectiveSidStart = sidLoadAddress;
        let effectiveSidEnd = sidLoadAddress + sidSize;

        // Cap at 0xFFFF to handle high-memory SIDs correctly
        if (effectiveSidEnd > 0xFFFF) effectiveSidEnd = 0xFFFF;

        const srSize = this._saveRestoreSizeFor(vizConfig, modifiedAddresses);

        // Relocatable players aren't bound to their declared banks: at export the
        // exporter relocates the graphics into any free VIC bank and the code into
        // free RAM (see placeRelocatedVisualizer). So judge them the way that
        // placement does - is there a free VIC bank for the graphics, and does the
        // whole footprint (tune + a bank's worth of player + any save/restore) fit
        // in the 64K address space - rather than by whether a fixed bank overlaps
        // the tune. (A rare placement edge case the exporter still rejects surfaces
        // as a clean export error, not a crash.)
        if (vizConfig.relocatable) {
            const RESERVE = 0x0800;   // zero page, stack, a little system headroom
            // Where the graphics image lands when relocated into a VIC bank, taken
            // from the (bank4000-relative) reloc base layout: gfxOffset = first
            // graphics asset, gfxSize = the whole image's length from the bank base.
            const baseLayout = vizConfig.layouts.bank4000 || Object.values(vizConfig.layouts)[0] || {};
            const baseAddr = parseInt(baseLayout.baseAddress || '0x4000');
            const gBase = baseLayout.graphicsBase ? parseInt(baseLayout.graphicsBase)
                : (baseLayout.colorTableAddress ? parseInt(baseLayout.colorTableAddress) : baseAddr + 0x2000);
            const gfxOffset = gBase - baseAddr;
            const gfxSize = parseInt(baseLayout.size || '0x4000');
            // Mirror placeRelocatedVisualizer's viable(): the graphics image must
            // clear the tune, stay below the CPU vectors ($FFFA) in the top bank,
            // avoid the $D000-$DFFF I/O hole, and not fall in the char-ROM shadow
            // ($1000/$9000). A full-bank player (logo/bitmap) whose graphics reach
            // the bank top therefore CAN'T use $C000 even when the tune leaves it
            // free - which is why a small player like Default fits a mid-memory SID
            // but the logo variant doesn't.
            const bankUsable = (b) => {
                const gStart = b + gfxOffset, gEnd = b + gfxSize;
                if (gEnd > 0x10000) return false;
                if (b === 0xC000) {
                    if (gEnd > 0xFFFA) return false;                    // CPU vectors
                    if (gStart < 0xE000 && gEnd > 0xD000) return false; // $D000-$DFFF I/O
                } else if (gEnd > 0xD000) return false;                // gfx can't cross into I/O
                if (gStart < effectiveSidEnd && effectiveSidStart < gEnd) return false;  // vs the tune
                for (const romLo of [0x1000, 0x9000]) if (gStart < romLo + 0x1000 && romLo < gEnd) return false;
                return true;
            };
            const hasBank = [0xC000, 0x8000, 0x4000].some(bankUsable);
            const totalFits = (sidSize + gfxSize + srSize) <= (0x10000 - RESERVE);
            const valid = hasBank && totalFits;
            const reason = valid ? null
                : (!hasBank
                    ? 'No free VIC bank for graphics alongside the tune'
                    : `Tune self-modifies too much memory (${Math.round(srSize / 1024)}K save/restore won't fit)`);
            for (const [key, layout] of Object.entries(vizConfig.layouts)) {
                const vizStart = parseInt(layout.baseAddress);
                validLayouts.push({
                    key, layout, valid,
                    vizStart, vizEnd: vizStart + gfxSize,
                    saveRestoreStart: effectiveSidEnd, saveRestoreEnd: effectiveSidEnd + srSize,
                    overlapReason: reason,
                });
            }
            return validLayouts;
        }

        // Non-relocatable (fixed-bank) players: a layout is valid only if its bank
        // doesn't overlap the tune and the save/restore still fits.
        for (const [key, layout] of Object.entries(vizConfig.layouts)) {
            const vizStart = parseInt(layout.baseAddress);
            const vizEnd = vizStart + parseInt(layout.size || '0x4000');

            // Check for overlaps - visualizer vs SID data range (without save/restore)
            const hasOverlap = !(vizEnd <= effectiveSidStart || vizStart >= effectiveSidEnd);

            const sidStartHex = '$' + effectiveSidStart.toString(16).toUpperCase().padStart(4, '0');
            const sidEndHex = '$' + effectiveSidEnd.toString(16).toUpperCase().padStart(4, '0');

            // Calculate where save/restore would actually go (after visualizer if needed)
            let saveRestoreStart = effectiveSidEnd;
            if (!hasOverlap && vizEnd > saveRestoreStart) {
                // If visualizer is after SID, save/restore goes after visualizer
                saveRestoreStart = this.alignToPage(vizEnd);
            }

            // Save/restore fit: a tune that self-modifies a lot of memory produces a
            // huge save/restore table (a few bytes per modified address). If the
            // SID + visualizer + that table can't coexist in 64K, give up on this
            // layout rather than emit one whose save/restore overruns memory.
            const vizSize = vizEnd - vizStart;
            const srFits = (sidSize + vizSize + srSize) <= 0x10000;

            validLayouts.push({
                key: key,
                layout: layout,
                valid: !hasOverlap && srFits,
                vizStart: vizStart,
                vizEnd: vizEnd,
                saveRestoreStart: saveRestoreStart,
                saveRestoreEnd: saveRestoreStart + srSize,
                overlapReason: hasOverlap
                    ? `Overlaps with SID (${sidStartHex}-${sidEndHex})`
                    : (!srFits ? `Tune self-modifies too much memory (${Math.round(srSize / 1024)}K save/restore won't fit)` : null)
            });
        }

        return validLayouts;
    }

    generateOptimizedSaveRoutine(modifiedAddresses, restoreRoutineAddr) {
        const code = [];
        let restoreOffset = 0;

        const filtered = modifiedAddresses
            .filter(addr => this._isSaveRestorable(addr))
            .sort((a, b) => a - b);

        for (const addr of filtered) {
            // Load from memory address
            if (addr < 256) {
                code.push(0xA5); // LDA zp
                code.push(addr);
            } else {
                code.push(0xAD); // LDA abs
                code.push(addr & 0xFF);
                code.push((addr >> 8) & 0xFF);
            }

            // Store into restore routine (self-modifying code)
            // Skip the LDA # opcode (1 byte) to get to the value byte
            const targetAddr = restoreRoutineAddr + restoreOffset + 1;
            code.push(0x8D); // STA abs
            code.push(targetAddr & 0xFF);
            code.push((targetAddr >> 8) & 0xFF);

            // Calculate next offset based on what the restore routine will use
            if (addr < 256) {
                restoreOffset += 4; // LDA # (2) + STA zp (2)
            } else {
                restoreOffset += 5; // LDA # (2) + STA abs (3)
            }
        }

        code.push(0x60); // RTS
        return new Uint8Array(code);
    }

    generateOptimizedRestoreRoutine(modifiedAddresses) {
        const code = [];

        const filtered = modifiedAddresses
            .filter(addr => this._isSaveRestorable(addr))
            .sort((a, b) => a - b);

        for (const addr of filtered) {
            // LDA immediate (value will be filled by save routine)
            code.push(0xA9); // LDA #
            code.push(0x00); // Placeholder value

            // Store to memory address
            if (addr < 256) {
                code.push(0x85); // STA zp (2 bytes)
                code.push(addr);
            } else {
                code.push(0x8D); // STA abs (3 bytes)
                code.push(addr & 0xFF);
                code.push((addr >> 8) & 0xFF);
            }
        }

        code.push(0x60); // RTS
        return new Uint8Array(code);
    }

    generateDataBlock(sidInfo, analysisResults, header, saveRoutineAddr, restoreRoutineAddr, numCallsPerFrame, maxCallsPerFrame, selectedSong = 0, modifiedCount = 0, sidChipCount = 1, needsSaveRestore = true, introScreenHi = 0x04, musicLoopFrames = 0) {
        const data = new Uint8Array(0x100);

        let effectiveCallsPerFrame = numCallsPerFrame;
        if (maxCallsPerFrame !== null && numCallsPerFrame > maxCallsPerFrame) {
            console.warn(`SID requires ${numCallsPerFrame} calls per frame, but visualizer supports max ${maxCallsPerFrame}. Limiting to ${maxCallsPerFrame}.`);
            effectiveCallsPerFrame = maxCallsPerFrame;
        }

        // JMP SIDInit at $xx00
        data[0] = 0x4C;
        data[1] = sidInfo.initAddress & 0xFF;
        data[2] = (sidInfo.initAddress >> 8) & 0xFF;

        // JMP SIDPlay at $xx03
        data[3] = 0x4C;
        data[4] = sidInfo.playAddress & 0xFF;
        data[5] = (sidInfo.playAddress >> 8) & 0xFF;

        if (needsSaveRestore) {
            // JMP SaveModifiedMemory at $xx06
            data[6] = 0x4C;
            data[7] = saveRoutineAddr & 0xFF;
            data[8] = (saveRoutineAddr >> 8) & 0xFF;

            // JMP RestoreModifiedMemory at $xx09
            data[9] = 0x4C;
            data[10] = restoreRoutineAddr & 0xFF;
            data[11] = (restoreRoutineAddr >> 8) & 0xFF;
        } else {
            // RTS + NOP + NOP at $xx06 (BackupSIDMemory - never called)
            data[6] = 0x60;  // RTS
            data[7] = 0xEA;  // NOP
            data[8] = 0xEA;  // NOP

            // RTS + NOP + NOP at $xx09 (RestoreSIDMemory - never called)
            data[9] = 0x60;  // RTS
            data[10] = 0xEA; // NOP
            data[11] = 0xEA; // NOP
        }

        data[0x0C] = effectiveCallsPerFrame & 0xFF;
        data[0x0D] = 0x00; // BorderColour (will be overwritten by options if present)
        data[0x0E] = 0x00; // BackgroundColour (will be overwritten by options if present)
        data[0x0F] = selectedSong & 0xFF;

        // Apply font case conversion if needed
        let nameStr = header.name || '';
        let authorStr = header.author || '';
        let copyrightStr = header.copyright || '';

        if (typeof FONT_DATA !== 'undefined' && this.currentFontCaseType !== undefined) {
            nameStr = FONT_DATA.convertTextForFont(nameStr, this.currentFontCaseType);
            authorStr = FONT_DATA.convertTextForFont(authorStr, this.currentFontCaseType);
            copyrightStr = FONT_DATA.convertTextForFont(copyrightStr, this.currentFontCaseType);
        }

        // SID Name at $xx10-$xx2F
        const nameBytes = this.stringToPETSCII(this.centerString(nameStr, 32), 32);
        for (let i = 0; i < 32; i++) {
            data[0x10 + i] = nameBytes[i];
        }

        // Author Name at $xx30-$xx4F
        const authorBytes = this.stringToPETSCII(this.centerString(authorStr, 32), 32);
        for (let i = 0; i < 32; i++) {
            data[0x30 + i] = authorBytes[i];
        }

        // Copyright at $xx50-$xx6F
        const copyrightBytes = this.stringToPETSCII(this.centerString(copyrightStr, 32), 32);
        for (let i = 0; i < 32; i++) {
            data[0x50 + i] = copyrightBytes[i];
        }

        // Technical metadata at $xxC0+
        data[0xC0] = sidInfo.loadAddress & 0xFF;
        data[0xC1] = (sidInfo.loadAddress >> 8) & 0xFF;

        data[0xC2] = sidInfo.initAddress & 0xFF;
        data[0xC3] = (sidInfo.initAddress >> 8) & 0xFF;

        data[0xC4] = sidInfo.playAddress & 0xFF;
        data[0xC5] = (sidInfo.playAddress >> 8) & 0xFF;

        const endAddress = sidInfo.loadAddress + (sidInfo.dataSize || 0x1000) - 1;
        data[0xC6] = endAddress & 0xFF;
        data[0xC7] = (endAddress >> 8) & 0xFF;

        data[0xC8] = (header.songs || 1) & 0xFF;

        const clockType = (header.clockType === 'NTSC') ? 1 : 0;
        data[0xC9] = clockType;

        const sidModel = (header.sidModel && header.sidModel.includes('8580')) ? 1 : 0;
        data[0xCA] = sidModel;

        // Store modified address count at $xxCB-$xxCC
        data[0xCB] = modifiedCount & 0xFF;
        data[0xCC] = (modifiedCount >> 8) & 0xFF;

        // Store number of SID chips at $xxCD (1-4, clamped)
        data[0xCD] = Math.min(Math.max(sidChipCount, 1), 4) & 0xFF;

        // Store the bank-0 intro screen page at $xxCE and the matching $d018
        // value at $xxCF (screen page + lowercase ROM charset $1800). Legacy
        // players use these to relocate the "Linked With" intro clear of a
        // low-loading SID.
        data[0xCE] = introScreenHi & 0xFF;
        data[0xCF] = (((introScreenHi << 2) & 0xF0) | 0x06) & 0xFF;

        // Forced song loop at $xxD0-$xxD2 (24-bit little-endian raster frame
        // count, 0 = disabled): live players count these frames and re-init the
        // tune when they run out; baked spectrometer players treat non-zero as
        // "restart the music on the baked stream's wrap". See INC/common.asm.
        const loopFrames = Math.max(0, Math.min(0xFFFFFF, Math.round(musicLoopFrames || 0)));
        data[0xD0] = loopFrames & 0xFF;
        data[0xD1] = (loopFrames >> 8) & 0xFF;
        data[0xD2] = (loopFrames >> 16) & 0xFF;

        // ZP usage data
        let zpString = 'NONE';
        if (analysisResults) {
            zpString = this.formatZPUsage(analysisResults.zpAddresses);
        }
        const zpBytes = this.stringToPETSCII(zpString, 32);
        for (let i = 0; i < 32; i++) {
            data[0xE0 + i] = zpBytes[i];
        }

        return data;
    }

    formatZPUsage(zpAddresses) {
        if (!zpAddresses || zpAddresses.length === 0) {
            return 'NONE';
        }

        const sorted = [...zpAddresses].sort((a, b) => a - b);
        const ranges = [];
        let currentRange = { start: sorted[0], end: sorted[0] };

        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] === currentRange.end + 1) {
                currentRange.end = sorted[i];
            } else {
                ranges.push(currentRange);
                currentRange = { start: sorted[i], end: sorted[i] };
            }
        }
        ranges.push(currentRange);

        const parts = ranges.map(r => {
            if (r.start === r.end) {
                return `$${r.start.toString(16).toUpperCase().padStart(2, '0')}`;
            } else {
                return `$${r.start.toString(16).toUpperCase().padStart(2, '0')}-$${r.end.toString(16).toUpperCase().padStart(2, '0')}`;
            }
        });

        // Build the string progressively, ensuring we don't break in the middle of a range
        let result = '';
        const maxLength = 20;
        const ellipsis = '...';
        const ellipsisLength = ellipsis.length;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const separator = i === 0 ? '' : ', ';
            const testString = result + separator + part;

            // Check if adding this part would exceed our limit
            if (testString.length > maxLength) {
                // If we haven't added anything yet, truncate the first part
                if (result === '') {
                    // This handles the edge case where even the first range is too long
                    if (part.length > maxLength - ellipsisLength) {
                        result = part.substring(0, maxLength - ellipsisLength) + ellipsis;
                    } else {
                        result = part;
                    }
                } else {
                    // We have content, check if we can fit the ellipsis
                    if (result.length <= maxLength - ellipsisLength) {
                        result = result + ellipsis;
                    } else {
                        // Remove the last complete range and add ellipsis
                        const lastComma = result.lastIndexOf(',');
                        if (lastComma > 0 && lastComma <= maxLength - ellipsisLength) {
                            result = result.substring(0, lastComma) + ellipsis;
                        } else {
                            // If we can't cleanly remove the last range, just truncate
                            result = result.substring(0, maxLength - ellipsisLength) + ellipsis;
                        }
                    }
                }
                break;
            }

            result = testString;
        }

        return result;
    }

    stringToPETSCIIRaw(str, length, useSystemFont = false) {
        const bytes = new Uint8Array(length);
        bytes.fill(32);  // Default to space (screen code 32)

        if (str && str.length > 0) {
            const maxLen = Math.min(str.length, length);

            for (let i = 0; i < maxLen; i++) {
                const code = str.charCodeAt(i);
                let screenCode = 32;  // Default to space

                if (useSystemFont) {
                    // C64 system font in lowercase mode:
                    // Screen codes 1-26 = lowercase a-z
                    // Screen codes 65-90 = uppercase A-Z
                    if (code >= 65 && code <= 90) {
                        // A-Z uppercase -> screen codes 65-90
                        screenCode = code;
                    } else if (code >= 97 && code <= 122) {
                        // a-z lowercase -> screen codes 1-26
                        screenCode = code - 96;
                    } else if (code >= 32 && code <= 63) {
                        // Space, symbols, digits (ASCII 32-63) -> same screen codes
                        screenCode = code;
                    } else if (code === 64) {
                        // @ -> screen code 0
                        screenCode = 0;
                    } else {
                        // Anything else: try to map to valid range 0-95
                        screenCode = ((code % 96) + 96) % 96;
                    }
                } else {
                    // Custom font layout: 1-26 = A-Z (uppercase), 65-90 = a-z (lowercase)
                    if (code >= 65 && code <= 90) {
                        // A-Z uppercase -> screen codes 1-26
                        screenCode = code - 64;
                    } else if (code >= 97 && code <= 122) {
                        // a-z lowercase -> screen codes 65-90
                        screenCode = code - 32;
                    } else if (code >= 32 && code <= 63) {
                        // Space, symbols, digits (ASCII 32-63) -> same screen codes
                        screenCode = code;
                    } else if (code === 64) {
                        // @ -> screen code 0
                        screenCode = 0;
                    } else {
                        // Anything else: try to map to valid range 0-95
                        screenCode = ((code % 96) + 96) % 96;
                    }
                }

                // Ensure screen code is in valid range 0-95
                if (screenCode < 0 || screenCode > 95) {
                    screenCode = 32;  // Default to space if still out of range
                }

                bytes[i] = screenCode & 0xFF;
            }
        }

        return bytes;
    }

    getOrdinalSuffix(day) {
        if (day > 3 && day < 21) return 'th';
        switch (day % 10) {
            case 1: return 'st';
            case 2: return 'nd';
            case 3: return 'rd';
            default: return 'th';
        }
    }

    async loadBinaryFile(url) {
        try {
            // no-cache: always revalidate. Player binaries and their reloc
            // tables are regenerated together; letting the browser serve a
            // stale cached .bin against a fresh (no-cache) reloc table applies
            // the new table's byte offsets to the old code and silently
            // corrupts the relocated PRG.
            const response = await fetch(url, { cache: 'no-cache' });
            if (!response.ok) {
                throw new Error(`Failed to load ${url}: ${response.statusText}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            return new Uint8Array(arrayBuffer);
        } catch (error) {
            console.error(`Error loading ${url}:`, error);
            throw error;
        }
    }

    extractSIDMusicData() {
        const modifiedSID = this.analyzer.createModifiedSID();
        if (!modifiedSID) {
            throw new Error('Failed to get SID data');
        }

        const view = new DataView(modifiedSID.buffer);
        const version = view.getUint16(0x04, false);
        const headerSize = (version === 1) ? 0x76 : 0x7C;

        let loadAddress = view.getUint16(0x08, false);
        let dataStart = headerSize;

        if (loadAddress === 0) {
            loadAddress = view.getUint16(headerSize, true);
            dataStart = headerSize + 2;
        }

        // Note: when the header declares a non-zero load address, PSID data
        // contains no embedded address, so the payload starts immediately.
        // (Music data legitimately starting with bytes that happen to equal
        // the load address must NOT be stripped.)
        const musicData = modifiedSID.slice(dataStart);

        return {
            data: musicData,
            loadAddress: loadAddress,
            dataSize: musicData.length
        };
    }

    async processVisualizerInputs(visualizerType, layoutKey = 'bank4000', relocXform = null) {
        const config = new VisualizerConfig();
        const vizConfig = await config.loadConfig(visualizerType);

        if (!vizConfig || !vizConfig.inputs) {
            return [];
        }

        const additionalComponents = [];

        // Canonical memory-map words for the graphics sub-regions an input places,
        // keyed by the (per-player, inconsistent) memConfig.name. Lets every logo
        // player render the same "Graphics: <input> <region>" labels as the base
        // graphics rows, without a mapLabel on each region in each JSON. Config
        // bytes (background, d022, ...) aren't listed - they fall back to the
        // id_region name and are folded out of the map anyway.
        const INPUT_REGION_WORD = {
            bitmap: 'bitmap', gfx: 'bitmap',
            screen: 'screen', screenCodes: 'screen',
            color: 'colour', colorData: 'colour',
        };

        for (const inputConfig of vizConfig.inputs) {
            const inputElement = document.getElementById(inputConfig.id);
            let fileData = null;

            if (inputElement && inputElement.files.length > 0) {
                const file = inputElement.files[0];

                // Check if this input uses logo conversion (CharSet Lab engine;
                // 'charset' restricts to text modes via charsetModes, 'logo'
                // conventionally allows the bitmap fallback too)
                if ((inputConfig.convertType === 'charset' || inputConfig.convertType === 'logo') &&
                    (file.type === 'image/png' || file.name.toLowerCase().endsWith('.png'))) {
                    fileData = await this.convertLogoPNG(file, inputConfig);
                }
                // Check if this input uses PETSCII conversion
                else if (inputConfig.convertType === 'petscii' && file.type === 'image/png') {
                    try {
                        if (typeof PETSCIIConverter === 'undefined') {
                            throw new Error('PETSCII converter not loaded. Please refresh the page.');
                        }
                        const petsciiConverter = new PETSCIIConverter();
                        await petsciiConverter.init();

                        // Get background color from bgColor option if available
                        const bgColorElement = document.getElementById('bgColor');
                        const bgColor = bgColorElement ? (parseInt(bgColorElement.value) & 0x0F) : 0;

                        fileData = await petsciiConverter.convertPNGToPETSCII(file, bgColor);
                    } catch (petsciiError) {
                        console.error('PETSCII conversion failed:', petsciiError);
                        throw new Error(`PETSCII conversion failed: ${petsciiError.message}`);
                    }
                }
                // Check if this is a PNG file that needs bitmap conversion
                else if (file.type === 'image/png' && file.name.toLowerCase().endsWith('.png')) {
                    // Check for PNG converter availability
                    if (typeof PNGConverter === 'undefined') {
                        console.error('PNGConverter not available');
                        throw new Error('PNG converter not loaded. Please refresh the page and try again.');
                    }

                    // Use the analyzer's own WASM instance rather than a shared
                    // window global - the global's name is brittle across cached
                    // script versions, and the exporter already holds the module.
                    const wasmModule = this.analyzer?.Module || window.SIDquakeModule;
                    if (!wasmModule) {
                        console.error('WASM module not available');
                        throw new Error('WASM module not ready. Please wait a moment and try again.');
                    }

                    try {
                        const converter = new PNGConverter(wasmModule);
                        converter.init();
                        const result = await converter.convertPNGToC64(file);
                        fileData = result.data;

                        // Verify standard C64 bitmap structure (10003/10004 bytes, load address $6000)
                        if ((fileData.length === 10003 || fileData.length === 10004) && fileData[0] === 0x00 && fileData[1] === 0x60) {
                        } else {
                            console.warn('Unexpected C64 image format - this may cause issues');
                        }
                    } catch (pngError) {
                        console.error('PNG conversion failed:', pngError);
                        throw new Error(`PNG conversion failed: ${pngError.message}`);
                    }
                } else {
                    // Handle regular binary files
                    try {
                        const arrayBuffer = await file.arrayBuffer();
                        fileData = new Uint8Array(arrayBuffer);
                    } catch (loadError) {
                        console.error('File loading failed:', loadError);
                        throw new Error(`Failed to load file ${file.name}: ${loadError.message}`);
                    }
                }
            } else if (inputConfig.default) {
                try {
                    const rawFileData = await config.loadDefaultFile(inputConfig.default);

                    // Check if this input uses logo conversion for the default PNG
                    if ((inputConfig.convertType === 'charset' || inputConfig.convertType === 'logo') && inputConfig.default.toLowerCase().endsWith('.png') && rawFileData && this.isPNGFile(rawFileData)) {
                        const blob = new Blob([rawFileData], { type: 'image/png' });
                        const pngFile = new File([blob], inputConfig.default.split('/').pop(), { type: 'image/png' });
                        fileData = await this.convertLogoPNG(pngFile, inputConfig);
                    }
                    // Check if this input uses PETSCII conversion for default PNG
                    else if (inputConfig.convertType === 'petscii' && inputConfig.default.toLowerCase().endsWith('.png') && rawFileData && this.isPNGFile(rawFileData)) {
                        try {
                            if (typeof PETSCIIConverter === 'undefined') {
                                throw new Error('PETSCII converter not loaded. Please refresh the page.');
                            }
                            const blob = new Blob([rawFileData], { type: 'image/png' });
                            const pngFile = new File([blob], inputConfig.default.split('/').pop(), { type: 'image/png' });

                            const petsciiConverter = new PETSCIIConverter();
                            await petsciiConverter.init();

                            const bgColorElement = document.getElementById('bgColor');
                            const bgColor = bgColorElement ? (parseInt(bgColorElement.value) & 0x0F) : 0;

                            fileData = await petsciiConverter.convertPNGToPETSCII(pngFile, bgColor);
                        } catch (petsciiError) {
                            console.error('Default PETSCII conversion failed:', petsciiError);
                            throw new Error(`Default PETSCII conversion failed: ${petsciiError.message}`);
                        }
                    }
                    // Check if the default file is a PNG that needs bitmap conversion
                    else if (inputConfig.default.toLowerCase().endsWith('.png') && this.isPNGFile(rawFileData)) {
                        // Check for PNG converter availability
                        if (typeof PNGConverter === 'undefined') {
                            console.error('PNGConverter not available');
                            throw new Error('PNG converter not loaded. Please refresh the page and try again.');
                        }

                        const wasmModule = this.analyzer?.Module || window.SIDquakeModule;
                        if (!wasmModule) {
                            console.error('WASM module not available');
                            throw new Error('WASM module not ready. Please wait a moment and try again.');
                        }

                        try {
                            // Create a blob from the PNG data and convert it to a File-like object
                            const blob = new Blob([rawFileData], { type: 'image/png' });
                            const file = new File([blob], inputConfig.default.split('/').pop(), { type: 'image/png' });

                            const converter = new PNGConverter(wasmModule);
                            converter.init();
                            const result = await converter.convertPNGToC64(file);
                            fileData = result.data;

                            if ((fileData.length === 10003 || fileData.length === 10004) && fileData[0] === 0x00 && fileData[1] === 0x60) {
                            } else {
                                console.warn('Default PNG conversion resulted in unexpected C64 image format');
                            }
                        } catch (pngError) {
                            console.error('Default PNG conversion failed:', pngError);
                            throw new Error(`Default PNG conversion failed: ${pngError.message}`);
                        }
                    } else {
                        // Use the raw file data for other binary files
                        fileData = rawFileData;
                    }
                } catch (defaultError) {
                    console.error('Default file loading failed:', defaultError);
                    throw new Error(`Failed to load default file ${inputConfig.default}: ${defaultError.message}`);
                }
            }

            if (fileData && inputConfig.memory && inputConfig.memory[layoutKey]) {
                const memoryRegions = inputConfig.memory[layoutKey];

                for (const memConfig of memoryRegions) {
                    const sourceOffset = parseInt(memConfig.sourceOffset);
                    // In a relocated export, shift the target into its relocated
                    // region (bitmap/screen/colour -> graphics bank; config bytes
                    // like bitmapMode/background -> code page).
                    const rawTarget = parseInt(memConfig.targetAddress);
                    const targetAddress = relocXform ? relocXform(rawTarget) : rawTarget;
                    const size = parseInt(memConfig.size);

                    // Bounds checking
                    if (sourceOffset >= fileData.length) {
                        console.warn(`Offset ${sourceOffset} exceeds file size ${fileData.length} for component ${memConfig.name}`);
                        continue;
                    }

                    const endOffset = Math.min(sourceOffset + size, fileData.length);
                    const data = fileData.slice(sourceOffset, endOffset);

                    if (data.length === 0) {
                        console.warn(`No data extracted for component ${memConfig.name}`);
                        continue;
                    }

                    additionalComponents.push({
                        data: data,
                        loadAddress: targetAddress,
                        // mapLabel gives the region an explicit name; otherwise a
                        // known graphics sub-region (bitmap/screen/colour) gets the
                        // consistent "Graphics: <input> <region>" label and anything
                        // else falls back to the id_region default. mapHidden keeps
                        // the bytes but drops the region from the map.
                        name: memConfig.mapLabel
                            || (INPUT_REGION_WORD[memConfig.name]
                                ? `Graphics: ${inputConfig.label.toLowerCase()} ${INPUT_REGION_WORD[memConfig.name]}`
                                : `${inputConfig.id}_${memConfig.name}`),
                        hidden: !!memConfig.mapHidden
                    });
                }
            }
        }

        return additionalComponents;
    }

    /**
     * Convert a logo PNG into the canonical logo blob via charsetlab-core
     * (CharSet Lab's analysis engine). The engine tries the requested modes
     * simplest-first (charset modes, then bitmap when allowed) and the blob's
     * fixed layout is CharsetLabCore.LOGO_BLOB; visualizer configs slice it
     * with their "memory" regions like any other converted input.
     *
     * inputConfig knobs:
     *   charsetModes    - modes to try, e.g. ["mixed"] for players that run
     *                     multicolour text mode, or
     *                     ["hires","mixed","ecm","bitmap"] for players that
     *                     take any logo type (default: all modes)
     *   charsetRows     - only the top N char rows carry content; the rest is
     *                     flattened to the background before analysis
     *   charsetMaxChars - the player's charset budget (default 256; only
     *                     applies to charset-mode results)
     */
    async convertLogoPNG(file, inputConfig) {
        if (typeof CharsetLabCore === 'undefined') {
            throw new Error('Charset converter not loaded. Please refresh the page and try again.');
        }
        const imageData = await new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                URL.revokeObjectURL(url);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(img, 0, 0);
                    resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
                } catch (err) {
                    reject(err);
                }
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the logo PNG')); };
            img.src = url;
        });
        const report = CharsetLabCore.analyse(imageData.data, imageData.width, imageData.height, {
            modes: inputConfig.charsetModes,
            rowLimit: inputConfig.charsetRows
        });
        if (!report.chosen) {
            throw new Error(`Logo conversion failed: ${CharsetLabCore.failureReason(report)}`);
        }
        let r = report.chosen;
        if (!r.isBitmap) {
            const maxChars = inputConfig.charsetMaxChars || 256;
            if (r.charCount > maxChars) {
                // Over this player's charset budget - fall back to a fitted
                // bitmap attempt when the input's mode list allowed one.
                const bmp = (report.attempts || []).find(a => a.ok && a.isBitmap);
                if (bmp) {
                    r = bmp;
                } else {
                    throw new Error(`Charset logo needs ${r.charCount} unique characters, ` +
                        `but this player only has room for ${maxChars}. Simplify the image and try again.`);
                }
            }
        }
        console.log(`Logo: ${r.label}${r.charCount != null ? `, ${r.charCount} chars` : ''}, ` +
            `$d021=${r.colours.bg}, $d022=${r.colours.mc1 ?? r.colours.bg2 ?? 0}, $d023=${r.colours.mc2 ?? r.colours.bg3 ?? 0}` +
            `${report.shift.dx || report.shift.dy ? `, shift (${report.shift.dx},${report.shift.dy})px` : ''}`);
        // Remembered for the font injection: a bitmap logo owns the charset
        // region its player's primary font copy would normally live in
        // (MusicalBlobs: $2500 in the bank is bitmap rows 4-6), so the font
        // handler must only write the alternate copy then.
        this.lastLogoIsBitmap = !!r.isBitmap;
        return CharsetLabCore.buildLogoBlob(r);
    }

    /**
     * Detect PNG files by their 8-byte magic number signature.
     */
    isPNGFile(data) {
        if (data.length < 8) return false;
        return data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47 &&
            data[4] === 0x0D && data[5] === 0x0A && data[6] === 0x1A && data[7] === 0x0A;
    }

    // Read an editable palette from a hidden input (comma-separated 0..15
    // values maintained by the palette-editor UI). Falls back to the supplied
    // default when the control is absent (e.g. headless exports).
    readPaletteInput(inputId, fallback) {
        const el = document.getElementById(inputId);
        if (!el || !el.value) return fallback;
        const vals = el.value.split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => !isNaN(n))
            .map(n => n & 0x0F);
        return vals.length ? vals : fallback;
    }

    async processVisualizerOptions(visualizerType, layoutKey = 'bank4000', layoutOverride = null) {
        const config = new VisualizerConfig();
        const vizConfig = await config.loadConfig(visualizerType);

        // Set useSystemFontMapping based on the visualizer's fontType.
        // 1x2 fonts follow the "custom" convention (A-Z at codes 1-26).
        // 1x1 fonts follow the C64 lowercase-ROM convention (a-z at codes 1-26,
        // A-Z at codes 65-90), the same as toPETSCIIBytes()'s system path —
        // both because the C64 ROM option uses lowercase ROM directly and
        // because the user's mixed-case PNG layout matches that mapping.
        const _vizFontType = vizConfig?.fontType;
        this.useSystemFontMapping = !_vizFontType || _vizFontType === '1x1';

        if (!vizConfig || !vizConfig.options) {
            return [];
        }

        // In relocated exports the caller passes the per-address-transformed layout
        // so option bytes are patched at their relocated positions.
        const layout = layoutOverride || vizConfig.layouts[layoutKey];
        if (!layout) {
            console.warn(`Layout ${layoutKey} not found`);
            return [];
        }

        // Reset font case type for this export
        this.currentFontCaseType = undefined;

        // Initialize sanitizer if not already done
        if (!this.sanitizer) {
            this.sanitizer = new PETSCIISanitizer();
        }

        const optionComponents = [];

        for (const optionConfig of vizConfig.options) {
            const element = document.getElementById(optionConfig.id);
            if (!element) continue;

            // Special handling for font when charset data should be injected
            if (optionConfig.id === 'font' && layout.charsetAddress && vizConfig.fontType) {
                const fontIndex = parseInt(element.value);
                const validIndex = !isNaN(fontIndex) ? fontIndex : (optionConfig.default ?? 0);

                // Get font data from the global FONT_DATA
                if (typeof FONT_DATA !== 'undefined') {
                    try {
                        // Prepare fallback config using the binary
                        const fallbackConfig = {
                            binarySource: layout.binary,
                            binaryOffset: parseInt(layout.charsetAddress) - parseInt(layout.baseAddress)
                        };

                        const fontData = await FONT_DATA.getFontData(vizConfig.fontType, validIndex, fallbackConfig);

                        // ROM sentinel: getFontData returns null. Skip charset
                        // injection and, if the layout exposes a fontModeAddress
                        // byte, leave it at its baked-in 0 value (ROM mode).
                        if (fontData === null) {
                            this.currentFontCaseType = await FONT_DATA.getFontCaseType(vizConfig.fontType, validIndex);
                            continue;
                        }

                        if (fontData) {
                            const targetAddress = parseInt(layout.charsetAddress);
                            // Respect charsetSize limit if specified in layout config
                            // This prevents overwriting color tables that may be placed
                            // immediately after the font data (e.g., RaistlinBarsWithLogo)
                            let fontDataToInject = fontData;
                            if (layout.charsetSize) {
                                const maxSize = parseInt(layout.charsetSize);
                                if (fontData.length > maxSize) {
                                    fontDataToInject = fontData.slice(0, maxSize);
                                }
                            }
                            // A bitmap logo owns the region the primary font
                            // copy lives in (it sits inside the player's logo
                            // charset slot), so only the alternate copy is
                            // written then - the player reads the song-name
                            // row through the alt charset slot in that mode.
                            const skipPrimaryFont = this.lastLogoIsBitmap && layout.charsetAltAddress;
                            if (!skipPrimaryFont) {
                                optionComponents.push({
                                    data: fontDataToInject,
                                    loadAddress: targetAddress,
                                    name: `Graphics: charset`
                                });
                            }

                            // Second font copy for players whose bitmap-logo
                            // mode reads the song-name row via another charset
                            // slot (MusicalBlobs: bank+$1000, glyphs at +$1500).
                            if (layout.charsetAltAddress) {
                                optionComponents.push({
                                    data: fontDataToInject,
                                    loadAddress: parseInt(layout.charsetAltAddress),
                                    name: `Graphics: charset (alt)`
                                });
                            }

                            // For visualizers that switch between ROM and RAM
                            // charset at runtime, flip the fontMode byte to 1
                            // so the asm uses the injected RAM charset.
                            if (layout.fontModeAddress) {
                                optionComponents.push({
                                    data: new Uint8Array([1]),
                                    loadAddress: parseInt(layout.fontModeAddress),
                                    name: `font_mode`
                                });
                            }

                            // Store the font case type for text conversion
                            this.currentFontCaseType = await FONT_DATA.getFontCaseType(vizConfig.fontType, validIndex);
                        }
                    } catch (fontError) {
                        console.warn('Failed to load font, using default:', fontError);
                        // Continue without custom font - binary will have default
                    }
                }
                continue;
            }

            // Special handling for barStyle when character data should be injected
            if (optionConfig.id === 'barStyle' && vizConfig.barStyleType && layout.barCharsAddress) {
                const styleIndex = parseInt(element.value);
                const validIndex = !isNaN(styleIndex) ? styleIndex : (optionConfig.default ?? 0);

                // Get bar style character data from the global BAR_STYLES_DATA
                if (typeof BAR_STYLES_DATA !== 'undefined') {
                    const charData = BAR_STYLES_DATA.getBarStyleData(vizConfig.barStyleType, validIndex);
                    if (charData) {
                        const targetAddress = parseInt(layout.barCharsAddress);
                        optionComponents.push({
                            data: charData,
                            loadAddress: targetAddress,
                            name: `Graphics: bar chars`
                        });
                    }
                }
                continue;
            }

            // Special handling for colorEffect: injects the effect mode byte plus
            // whichever colour table that mode consumes. Modes 0/1 read the
            // editable 6-colour fade, mode 2 the editable column hues.
            if (optionConfig.id === 'colorEffect' && vizConfig.colorEffectType && layout.colorEffectModeAddress) {
                const effectIndex = parseInt(element.value);
                const validEffectIndex = !isNaN(effectIndex) ? effectIndex : (optionConfig.default ?? 0);

                if (typeof COLOR_PALETTES_DATA !== 'undefined') {
                    // Inject colorEffectMode byte
                    const effectModeData = new Uint8Array(1);
                    effectModeData[0] = validEffectIndex & 0xFF;
                    optionComponents.push({
                        data: effectModeData,
                        loadAddress: parseInt(layout.colorEffectModeAddress),
                        name: `colorEffect_mode`
                    });

                    const fade = this.readPaletteInput('colorFade', COLOR_PALETTES_DATA.DEFAULT_FADE);
                    const columns = this.readPaletteInput('barColumns', COLOR_PALETTES_DATA.DEFAULT_COLUMNS);

                    // Mode 0 = Dynamic Pulse: height -> colour lookup table
                    if (validEffectIndex === 0 && vizConfig.colorPaletteType && layout.colorTableAddress) {
                        const colorData = COLOR_PALETTES_DATA.getHeightColorTable(vizConfig.colorPaletteType, fade);
                        if (colorData) {
                            optionComponents.push({
                                data: colorData,
                                loadAddress: parseInt(layout.colorTableAddress),
                                name: `Graphics: colour table → $D800`
                            });
                        }
                    }

                    // Mode 3 = Voice Waveform: 4 waveform-family colour ramps,
                    // injected into the same table region (mode 0 doesn't use it)
                    if (validEffectIndex === 3 && vizConfig.colorPaletteType && layout.colorTableAddress) {
                        const waveRamps = this.readPaletteInput('waveColors', COLOR_PALETTES_DATA.DEFAULT_WAVE_RAMPS);
                        const waveColors = COLOR_PALETTES_DATA.generateWaveColorTable(vizConfig.colorPaletteType, waveRamps);
                        optionComponents.push({
                            data: waveColors,
                            loadAddress: parseInt(layout.colorTableAddress),
                            name: `Graphics: waveform colour table → $D800`
                        });
                    }

                    // Mode 2 = Rainbow Columns: fixed colour per bar column
                    if (validEffectIndex === 2 && layout.barGradientColorsAddress) {
                        optionComponents.push({
                            data: COLOR_PALETTES_DATA.generateBarColumnColors(COLOR_PALETTES_DATA.NUM_FREQUENCY_BARS, columns),
                            loadAddress: parseInt(layout.barGradientColorsAddress),
                            name: `colorEffect_barColors`
                        });
                    }

                    // Mode 1 = Fixed Gradient: per-row colours from the fade
                    if (validEffectIndex === 1 && layout.lineGradientColorsAddress) {
                        let lineColors;
                        const effectType = vizConfig.colorEffectType;

                        if (effectType === 'water') {
                            lineColors = COLOR_PALETTES_DATA.generateLineGradientWater(14, 3, fade);
                        } else if (effectType === 'waterlogo') {
                            lineColors = COLOR_PALETTES_DATA.generateLineGradientWater(8, 3, fade);
                        } else if (effectType === 'mirror') {
                            lineColors = COLOR_PALETTES_DATA.generateLineGradientMirror(9, fade);
                        } else if (effectType === 'mirrorlogo') {
                            lineColors = COLOR_PALETTES_DATA.generateLineGradientMirror(5, fade);
                        }

                        if (lineColors) {
                            optionComponents.push({
                                data: lineColors,
                                loadAddress: parseInt(layout.lineGradientColorsAddress),
                                name: `colorEffect_lineColors`
                            });
                        }
                    }
                }
                continue;
            }

            // Handle color picker options (songNameColor, artistNameColor, bgColor)
            if (optionConfig.type === 'colorPicker') {
                const colorValue = parseInt(element.value);
                const validColor = !isNaN(colorValue) ? (colorValue & 0x0F) : (optionConfig.default ?? 0);

                if (optionConfig.id === 'songNameColor' && layout.songNameColorAddress) {
                    const colorData = new Uint8Array(1);
                    colorData[0] = validColor;
                    optionComponents.push({
                        data: colorData,
                        loadAddress: parseInt(layout.songNameColorAddress),
                        name: 'songNameColor'
                    });
                } else if (optionConfig.id === 'artistNameColor' && layout.artistNameColorAddress) {
                    const colorData = new Uint8Array(1);
                    colorData[0] = validColor;
                    optionComponents.push({
                        data: colorData,
                        loadAddress: parseInt(layout.artistNameColorAddress),
                        name: 'artistNameColor'
                    });
                } else if (optionConfig.id === 'borderColor' && layout.borderColor) {
                    // A visualizer that offers a separate border control owns
                    // layout.borderColor; bgColor then only paints the screen.
                    const borderData = new Uint8Array(1);
                    borderData[0] = validColor;
                    optionComponents.push({
                        data: borderData,
                        loadAddress: parseInt(layout.borderColor),
                        name: 'borderColor'
                    });
                } else if (optionConfig.id === 'bgColor') {
                    // Border follows the background ONLY where the visualizer has
                    // no border control of its own - a black border around a
                    // dark-grey screen is the most ordinary C64 framing there is,
                    // and tying the two together made it unbuildable.
                    const hasBorderOption = (vizConfig?.options || []).some(o => o.id === 'borderColor');
                    if (layout.borderColor && !hasBorderOption) {
                        const borderData = new Uint8Array(1);
                        borderData[0] = validColor;
                        optionComponents.push({
                            data: borderData,
                            loadAddress: parseInt(layout.borderColor),
                            name: 'bgColor_border'
                        });
                    }
                    if (layout.spectrometerBgColorAddress) {
                        // WithLogo visualizers: write to spectrometer bg color
                        // (logo bg is determined by PNG conversion, not user-editable)
                        const specBgData = new Uint8Array(1);
                        specBgData[0] = validColor;
                        optionComponents.push({
                            data: specBgData,
                            loadAddress: parseInt(layout.spectrometerBgColorAddress),
                            name: 'bgColor_spectrometer'
                        });
                    } else if (layout.backgroundColor) {
                        // Non-logo visualizers: write to backgroundColor as before
                        const bgData = new Uint8Array(1);
                        bgData[0] = validColor;
                        optionComponents.push({
                            data: bgData,
                            loadAddress: parseInt(layout.backgroundColor),
                            name: 'bgColor_background'
                        });
                    }
                }
                continue;
            }

            if (optionConfig.dataField && layout[optionConfig.dataField]) {
                const targetAddress = parseInt(layout[optionConfig.dataField]);

                if (optionConfig.type === 'date') {
                    const dateValue = element.value;
                    let formattedDate = '';

                    if (dateValue) {
                        const date = new Date(dateValue);
                        const day = date.getDate();
                        const months = ['January', 'February', 'March', 'April', 'May', 'June',
                            'July', 'August', 'September', 'October', 'November', 'December'];
                        const month = months[date.getMonth()];
                        const year = date.getFullYear();

                        const suffix = this.getOrdinalSuffix(day);
                        formattedDate = `${day}${suffix} ${month} ${year}`;
                    }

                    // Sanitize the date string
                    const sanitized = this.sanitizer.sanitize(formattedDate, {
                        maxLength: 32,
                        padToLength: 32,
                        center: true,
                        reportUnknown: false
                    });

                    const data = this.sanitizer.toPETSCIIBytes(sanitized.text, this.useSystemFontMapping);

                    optionComponents.push({
                        data: data,
                        loadAddress: targetAddress,
                        name: `option_${optionConfig.id}`
                    });

                } else if (optionConfig.type === 'number' || optionConfig.type === 'select') {
                    // Use proper null check to handle 0 values correctly
                    // (0 is falsy in JS but is a valid color value)
                    const parsedValue = parseInt(element.value);
                    const value = !isNaN(parsedValue) ? parsedValue : (optionConfig.default ?? 0);
                    const data = new Uint8Array(1);
                    data[0] = value & 0xFF;

                    optionComponents.push({
                        data: data,
                        loadAddress: targetAddress,
                        name: `option_${optionConfig.id}`
                    });

                } else if (optionConfig.type === 'textarea') {
                    const textValue = element.value || optionConfig.default || '';

                    // Sanitize the textarea content
                    const sanitized = this.sanitizer.sanitize(textValue, {
                        maxLength: optionConfig.maxLength || 255,
                        preserveNewlines: false,  // Convert newlines to spaces for scrolltext
                        reportUnknown: true
                    });

                    // Show warnings if any problematic characters were found
                    if (sanitized.hasWarnings) {
                        this.sanitizer.showWarningDialog(sanitized.warnings);
                    }

                    // Optional leading gap (prependSpaces): pad the front so a
                    // scroller starts (and loops) with a clear run before the text.
                    // Only when there's actually text, so an empty scroll text still
                    // reads as "no scroller".
                    let scrollTextStr = sanitized.text;
                    if (optionConfig.prependSpaces && scrollTextStr.length > 0) {
                        scrollTextStr = ' '.repeat(optionConfig.prependSpaces) + scrollTextStr;
                    }

                    // Convert to PETSCII bytes - use system font mapping if no custom font
                    const petsciiData = this.sanitizer.toPETSCIIBytes(scrollTextStr, this.useSystemFontMapping);

                    // Append null terminator so the C64-side scrolltext routine can detect end of string
                    const data = new Uint8Array(petsciiData.length + 1);
                    data.set(petsciiData);
                    data[data.length - 1] = 0x00;

                    optionComponents.push({
                        data: data,
                        loadAddress: targetAddress,
                        name: optionConfig.mapLabel || `option_${optionConfig.id}`
                    });
                }
            }
        }

        return optionComponents;
    }

    stringToPETSCII(str, length) {
        // Initialize sanitizer if not already done
        if (!this.sanitizer) {
            this.sanitizer = new PETSCIISanitizer();
        }

        // Sanitize the string
        const sanitized = this.sanitizer.sanitize(str || '', {
            maxLength: length,
            padToLength: length,
            center: false,
            reportUnknown: false  // Don't report for metadata fields
        });

        // Convert to PETSCII bytes - use system font mapping if no custom font
        return this.sanitizer.toPETSCIIBytes(sanitized.text, this.useSystemFontMapping);
    }

    centerString(str, length) {
        if (!this.sanitizer) {
            this.sanitizer = new PETSCIISanitizer();
        }

        const sanitized = this.sanitizer.sanitize(str || '', {
            maxLength: length,
            padToLength: length,
            center: true,
            reportUnknown: false
        });

        return sanitized.text;
    }

    // Precompute + place the baked FFT spectrometer data for the current tune.
    // Renders the tune, vector-quantizes its 40-bar FFT heights, places the
    // codebook + index stream in free RAM, and patches the three data-block
    // config words the RaistlinBars (FFT) player reads at runtime.
    async processSpectrometerBake(vizConfig, layout, sidLoadAddress, sidDataLength, selectedSong = 0, onProgress = null, reservedRanges = [], bakeParams = null, forceLoop = false) {
        const sidBytes = this.analyzer.createModifiedSID();
        if (!sidBytes) {
            throw new Error('Spectrometer bake: could not obtain SID data for the current tune');
        }

        // Keyframe rate + loop-search window come from the export modal (bakeParams);
        // fall back to any inline DOM controls, then to defaults. We must render at
        // least twice a loop's length to confirm it, so the analysis cap is 2x the
        // chosen "max song length" (the user never sees the doubling).
        const domInt = (id, dflt) => {
            const el = typeof document !== 'undefined' && document.getElementById(id);
            return el ? (parseInt(el.value, 10) || dflt) : dflt;
        };
        const maxLoopSeconds = (bakeParams && bakeParams.maxLoopSeconds) || domInt('loopSearchSeconds', 600);
        const analysisSeconds = Math.max(30, maxLoopSeconds * 2);
        const framesPerKeyframe = Math.min(3, Math.max(1,
            (bakeParams && bakeParams.framesPerKeyframe) || domInt('bakedFps', 2)));
        // Loop-repeat threshold (Advanced setting): the shortest musical span
        // that counts as the tune having looped. Must match the value the
        // on-load analysis used, or the bake could resolve a different loop.
        const minLoopSeconds = (bakeParams && bakeParams.minLoopSeconds) || 2;
        // SID engine the analysis renders with (Advanced setting): 'fp' (libsidplayfp)
        // is the accurate default, 'resid' the ~2x faster opt-in. It has to match what
        // the on-load analysis used, or this export re-renders the tune from scratch.
        const bakeEngine = (bakeParams && bakeParams.bakeEngine) === 'resid' ? 'resid' : 'fp';
        // How much of a NON-looping tune to store (Advanced setting). A shorter
        // stream costs fewer index bytes per keyframe, which is what buys back the
        // 5-way spectral split - see chooseSegments in spectrometer-bake.js. No
        // effect on a tune with a real loop: that stores exactly one cycle.
        const outputMaxSeconds = (bakeParams && bakeParams.outputMaxSeconds) || 480;

        // Spectrometer always bakes the tune's DEFAULT song, never a hard-coded song 0
        // and never a different pick from the multi-song selector: the baked stream is
        // one subtune's, the on-load analysis used the default song, and a multi-song
        // export is gated on the user accepting that only the default song is baked.
        const defaultSong = Math.max(0, ((this.analyzer && this.analyzer.sidHeader && this.analyzer.sidHeader.startSong) || 1) - 1);

        const { renderAndBakeSpectrometer } = await import((window.cacheBust || (s => s))('./spectrometer-bake-runner.js'));
        const baked = await renderAndBakeSpectrometer(sidBytes, {
            subtune: defaultSong,
            maxSeconds: analysisSeconds,   // render up to 2x the max loop length (stops early when a loop is found)
            outputMaxSeconds,       // if no loop is found, store at most this many seconds of bars, then fade off
            numBars: vizConfig.bakedNumBars,
            maxHeight: vizConfig.bakedMaxHeight,
            framesPerKeyframe,
            minLoopSeconds,
            engine: bakeEngine,
            // Forced song loop for fade-out tunes: the bake trims the silent tail
            // and wraps the stream to keyframe 0; the player restarts the music on
            // that wrap (no-op for tunes with a real detected loop).
            forceLoop: !!forceLoop,
            onProgress: onProgress || undefined,
        });

        // Place the codebook + index in free RAM. The codebook MUST be page-aligned
        // (the player steps its high byte one page per bar); the index is read with
        // indexed-absolute addressing, so it needs no alignment. findSafeMemory avoids
        // every component already added (SID + player binary) plus, via an extra
        // reserved range, whichever of the pair we place first. It falls back to $0900
        // when nothing fits, so each candidate is validated and we fail loudly rather
        // than silently overwriting code/data.
        //
        // Because only one of the two needs aligning, the order changes the footprint:
        // leading with the unaligned index drops the alignment pad off the front but
        // adds a (usually smaller) pad before the codebook - or not, depending on where
        // free RAM starts. So we try BOTH orders and keep whichever reaches the lower
        // top address (more headroom, likelier to fit under the I/O hole / RAM top).
        const CB  = { key: 'cb',  data: baked.codebook, name: 'Spectrometer codebook data', align: true };
        const IDX = { key: 'idx', data: baked.indices,  name: 'Spectrometer index data',    align: false };
        const rangeOf = (addr, size) => ({ start: addr, end: addr + size });
        const validPlacement = (addr, size) => {
            const end = addr + size;
            if (end > 0x10000) return false;
            if (addr < 0xE000 && end > 0xD000) return false;     // never straddle the I/O hole
            return !this.builder.components.some(c => addr < c.loadAddress + c.size && end > c.loadAddress);
        };
        const tryOrder = (first, second) => {
            const aF = this.findSafeMemoryForRoutines(first.data.length, sidLoadAddress, sidDataLength, reservedRanges, first.align);
            if (aF === null) return { ok: false, top: Infinity, addrs: {} };
            const aS = this.findSafeMemoryForRoutines(second.data.length, sidLoadAddress, sidDataLength,
                [...reservedRanges, rangeOf(aF, first.data.length)], second.align);
            if (aS === null) return { ok: false, top: Infinity, addrs: {} };
            const overlapPair = aF < aS + second.data.length && aF + first.data.length > aS;
            const ok = validPlacement(aF, first.data.length) && validPlacement(aS, second.data.length) && !overlapPair;
            const top = Math.max(aF + first.data.length, aS + second.data.length);
            return { ok, top, addrs: { [first.key]: aF, [second.key]: aS } };
        };
        const orders = [tryOrder(CB, IDX), tryOrder(IDX, CB)]
            .filter(o => o.ok)
            .sort((a, b) => a.top - b.top);
        if (!orders.length) {
            const kb = (baked.totalBytes / 1024).toFixed(1);
            throw new Error(
                `Spectrometer bake: no free RAM for the codebook + index (${kb} KB total). ` +
                `This tune + player leave too little contiguous memory. ` +
                `Try a shorter tune, a different memory layout, or a different visualizer.`);
        }
        const { cb: cbAddr, idx: idxAddr } = orders[0].addrs;
        this.builder.addComponent(baked.codebook, cbAddr, 'Spectrometer codebook data');
        this.builder.addComponent(baked.indices, idxAddr, 'Spectrometer index data');

        // Patch the little-endian config words inside the player's data block.
        const word = (v) => new Uint8Array([v & 0xFF, (v >> 8) & 0xFF]);
        this.builder.addComponent(word(cbAddr),  parseInt(layout.bakedCodebookPtrAddress),  'Spectrometer config');
        this.builder.addComponent(word(idxAddr), parseInt(layout.bakedIndexStartAddress),   'Spectrometer config');
        this.builder.addComponent(word(baked.numKeyframes), parseInt(layout.bakedNumKeyframesAddress), 'Spectrometer config');
        if (layout.bakedLoopStartAddress) {
            this.builder.addComponent(word(baked.loopStart || 0), parseInt(layout.bakedLoopStartAddress), 'Spectrometer config');
        }
        // Split-VQ geometry (chosen per tune): segment count + bars per segment.
        const byte = (v) => new Uint8Array([v & 0xFF]);
        this.builder.addComponent(byte(baked.segments),      parseInt(layout.bakedNumSegmentsAddress), 'Spectrometer config');
        this.builder.addComponent(byte(baked.segmentWidth),  parseInt(layout.bakedSegWidthAddress),    'Spectrometer config');
        // Keyframe cadence: frames per keyframe (1/2/3 = 50/25/16.66 Hz).
        if (layout.bakedFrameDivisorAddress) {
            this.builder.addComponent(byte(baked.framesPerKeyframe || 2), parseInt(layout.bakedFrameDivisorAddress), 'Spectrometer config');
        }
        // On-screen clock: loop-point time (the timer re-syncs here on a wrap, so it
        // tracks true position past an intro) and the song length (shown only when a
        // loop gave us a real one). The player's clock counts raster FRAMES, so the
        // loop point is written frame-exact - MM:SS plus an intra-second frame
        // remainder (bakedLoopFrameRem), never rounded to a whole second. A loop at
        // 43.34s resets the clock to 43s + 17 frames, so repeated wraps can't drift
        // the display against the stream. MM clamps to the 99:59 the timer shows.
        const fpk = baked.framesPerKeyframe || 2;
        const fps = Math.max(1, Math.round((baked.keyframeHz || 25) * fpk));
        const triple = (keyframes) => {
            const frames = Math.max(0, (keyframes || 0) * fpk);
            const tot = Math.floor(frames / fps);
            return { m: Math.min(99, Math.floor(tot / 60)), s: Math.min(59, tot % 60), rem: frames % fps };
        };
        const loopT = triple(baked.loopStart);
        const lenT = triple(baked.numKeyframes);
        // Song length is only meaningful for a single-song SID: a multi-song tune can
        // switch songs (live players) and the baked length would be wrong, so we never
        // show it there - the player keeps the timer alone.
        const multiSong = !!(this.analyzer && this.analyzer.sidHeader && this.analyzer.sidHeader.songs > 1);
        // A forced loop gives the tune a real length too: the clock counts up to
        // the wrap (= the stream length) and snaps back to 0:00 as the music
        // restarts (loopStart is 0 for a forced loop, so loopT is all zeros).
        const forcedLoop = !!baked.forcedLoop;
        const hasLength = ((baked.looped || forcedLoop) && !multiSong) ? 1 : 0;
        // The player restarts the music on the stream wrap whenever this is
        // non-zero (see INC/timer.asm ResetTimerToLoop). The value itself is the
        // wrap period in raster frames - informational, the wrap event drives it.
        this.lastMusicLoopFrames = forcedLoop ? Math.min(0xFFFFFF, (baked.numKeyframes || 0) * fpk) : 0;
        if (layout.bakedLoopMinAddress) this.builder.addComponent(byte(loopT.m), parseInt(layout.bakedLoopMinAddress), 'Spectrometer config');
        if (layout.bakedLoopSecAddress) this.builder.addComponent(byte(loopT.s), parseInt(layout.bakedLoopSecAddress), 'Spectrometer config');
        if (layout.bakedLoopFrameRemAddress) this.builder.addComponent(byte(loopT.rem), parseInt(layout.bakedLoopFrameRemAddress), 'Spectrometer config');
        if (layout.bakedLenMinAddress)  this.builder.addComponent(byte(hasLength ? lenT.m : 0), parseInt(layout.bakedLenMinAddress), 'Spectrometer config');
        if (layout.bakedLenSecAddress)  this.builder.addComponent(byte(hasLength ? lenT.s : 0), parseInt(layout.bakedLenSecAddress), 'Spectrometer config');
        if (layout.bakedHasLengthAddress) this.builder.addComponent(byte(hasLength), parseInt(layout.bakedHasLengthAddress), 'Spectrometer config');

        const bakedFps = (baked.keyframeHz || 25).toFixed(1);
        console.log(`Spectrometer bake: ${baked.segments}x${baked.segmentWidth} split, ${baked.numKeyframes} keyframes @${bakedFps}Hz` +
            `${baked.loopStart ? `, loop@${baked.loopStart}` : ''}, ` +
            `codebook@$${cbAddr.toString(16)} (${baked.codebook.length}B), ` +
            `index@$${idxAddr.toString(16)} (${baked.indices.length}B), ` +
            `total ${(baked.totalBytes / 1024).toFixed(1)}KB`);

        // Stash loop/timing info for the UI's baked-spectrometer timeline panel.
        this.lastBakeInfo = {
            keyframeHz: baked.keyframeHz,
            numKeyframes: baked.numKeyframes,
            loopStart: baked.loopStart,
            looped: baked.looped,
            fadedOut: baked.fadedOut,
            forcedLoop: forcedLoop,
            analyzedKeyframes: baked.analyzedKeyframes,
            analyzedSeconds: baked.analyzedSeconds,
            cappedAtMaxSeconds: baked.cappedAtMaxSeconds,
            K: baked.K,
            // Spectral split: how many independently-quantized slices the 40 bars
            // were cut into, and how wide each is. Surfaced in the bake timeline -
            // 1x40 is the "everything freezes together" case.
            segments: baked.segments,
            segmentWidth: baked.segmentWidth,
            codebookBytes: baked.codebook.length,
            indexBytes: baked.indices.length,
            totalBytes: baked.totalBytes,
            codebookAddr: cbAddr,
            indexAddr: idxAddr,
        };
    }

    // Shadow-register method: analyse the tune's SID write order, repoint every
    // $D4xx store at the player's page-aligned mirror (sidInfo.data is held by
    // reference, so patching it here still reaches the built PRG) and bake the
    // canonical replay order. Multi-SID works because only the store's high byte
    // is repointed, so all four chips share one mirror page at their natural $20
    // spacing. Fails loudly if the tune isn't suitable (a SID write that can't be
    // redirected, or chips off the $D400/$20 grid) or the store sites don't line up.
    async processSpectrometerShadow(vizConfig, layout, sidInfo, header, selectedSong = 0) {
        const sidBytes = this.analyzer.createModifiedSID();
        if (!sidBytes) throw new Error('Shadow: could not obtain SID data for the current tune');

        const { analyzeShadow, MAX_SHADOW_CHIPS } = await import((window.cacheBust || (s => s))('./spectrometer-shadow-detect.js'));

        // The player mirrors and replays chip N at $D400 + $20*N, so the tune's
        // chips have to sit on that grid. Every real multi-SID layout we handle
        // does ($D420/$D440/$D460); anything else would replay one chip's values
        // to an address no chip listens on - which on a stock C64 mirrors back
        // onto SID 1 and wrecks the audio. Refuse rather than export that.
        const chipAddresses = this.analyzer.analysisResults?.sidChipAddresses || [];
        const numChips = Math.min(Math.max(this.analyzer.analysisResults?.sidChipCount || 1, 1), MAX_SHADOW_CHIPS);
        const offGrid = chipAddresses.filter((a, i) => a !== 0xD400 + i * 0x20);
        if (offGrid.length || chipAddresses.length > MAX_SHADOW_CHIPS) {
            throw new Error(
                `Shadow method won't work for this tune: its SID chips sit at ` +
                `${chipAddresses.map(a => '$' + a.toString(16).toUpperCase()).join(', ')}, ` +
                `but the shadow player only handles up to ${MAX_SHADOW_CHIPS} chips at ` +
                `$D400/$D420/$D440/$D460. Use the realtime variant instead.`);
        }

        const res = analyzeShadow(this.analyzer.Module, sidBytes, {
            initAddress: header.initAddress,
            playAddress: header.playAddress,
            loadAddress: header.loadAddress,
            subtune: selectedSong,
            numChips,
            frames: 1200,
        });
        if (res.leakedWrites) {
            // A SID write we can't redirect (e.g. an indirect or self-modifying
            // store address) - if we can't capture every write we can't safely
            // mask the SID.
            throw new Error(
                `Shadow method won't work for this tune: ${res.leakedWrites} SID ` +
                `write(s) don't come from a redirectable store instruction, so the ` +
                `SID can't be fully masked. Use the realtime variant instead.`);
        }
        if (!res.suitable) {
            // An indexed store reached past the last register the mirror covers,
            // so redirecting it would write over whatever the player keeps after
            // the mirror instead of into it.
            throw new Error(
                `Shadow method won't work for this tune: ${res.overflowWrites} redirected ` +
                `write(s) land past the end of the player's SID mirror. Use the ` +
                `realtime variant instead.`);
        }

        // Repoint each store's high byte ($D4) at the mirror page. Only touch
        // bytes that are actually $D4 so a layout mismatch can't corrupt code.
        const mirrorPage = parseInt(layout.shadowMirrorAddress) >> 8;
        let patched = 0;
        for (const off of res.storeSites) {
            if (off >= 0 && off < sidInfo.data.length && sidInfo.data[off] === 0xD4) {
                sidInfo.data[off] = mirrorPage; patched++;
            }
        }
        if (patched !== res.storeSites.length) {
            throw new Error(`Shadow: ${res.storeSites.length - patched} of ${res.storeSites.length} ` +
                `SID store sites didn't line up with the exported music - cannot safely redirect.`);
        }

        // Bake the replay order: 25 entries per chip, each an offset from $D400
        // ($20*chip + register), followed by the $FF terminator that stops the
        // player's replay loop. analyzeShadow guarantees exactly 25 per chip;
        // clamp defensively so a stray value can't shift the component size and
        // corrupt the following memory.
        const maxOffset = (numChips - 1) * 0x20 + 0x18;
        const regs = res.order.filter(r => r >= 0 && r <= maxOffset);
        if (regs.length !== 25 * numChips) {
            throw new Error(`Shadow: expected a ${25 * numChips}-entry replay order for ` +
                `${numChips} SID chip(s), got ${regs.length}.`);
        }
        const order = Uint8Array.from([...regs, 0xFF]);
        this.builder.addComponent(order, parseInt(layout.shadowOrderAddress), 'Shadow Order');

        console.log(`Shadow: replay ${regs.length} regs across ${numChips} chip(s) ` +
            `(${res.usedFallback ? 'fallback order' : `detected, ` +
            `${(res.consistency * 100).toFixed(0)}% consistent`}), ${patched} stores -> mirror page ` +
            `$${mirrorPage.toString(16)}, order@${layout.shadowOrderAddress}`);
    }

    // Pure relocation planner (no side effects) - testable in isolation. Given the
    // base image + reloc table + where the SID sits, decide a graphics VIC bank and
    // a code page, relocate the image (code refs by the code delta, gfx refs by the
    // bank delta, VIC-config anomaly bytes recomputed for the chosen bank), split it
    // into code + graphics blobs, and transform the layout addresses to match.
    // Returns everything the caller needs to place the components + patch options.
    planRelocation(table, baseBin, baseLayout, actualSidAddress, sidDataLength, chooseCodePage) {
        // Same staleness guard as planRelocationCodeOnly: a table applied to a
        // binary it wasn't generated with corrupts the relocated code.
        if (table.size != null && baseBin.length !== table.size) {
            throw new Error(`player binary (${baseBin.length}B) doesn't match its reloc table (${table.size}B) - stale cached file?`);
        }
        const base = table.base;                 // $4000
        const size = baseBin.length;
        const split = table.splitPoint;
        const splitOff = split - base;
        const sidStart = actualSidAddress, sidEnd = actualSidAddress + sidDataLength;

        // Graphics-free player (e.g. SimpleRaster): no gfx refs, no VIC config - the
        // whole image is code and relocates to any free page in one blob.
        if (table.gfxFree) {
            const codePage = chooseCodePage(size, null);
            // No free page big enough (a very large SID leaving no contiguous gap).
            // Fail loudly: a null here would coerce to 0 in the delta math below and
            // silently relocate the whole player into zero page.
            if (codePage === null) {
                throw new Error(
                    `No free RAM to relocate the ${size}-byte player past this tune - ` +
                    `the SID leaves no contiguous free page. Try a shorter tune or a different memory layout.`);
            }
            const codeDeltaPg = ((codePage - base) >> 8) & 0xff;
            const codeDeltaAddr = codePage - base;
            const img = new Uint8Array(baseBin);
            for (const o of table.codeRefs) img[o] = (img[o] + codeDeltaPg) & 0xff;
            const layout = { ...baseLayout };
            for (const k of Object.keys(layout)) {
                const v = layout[k];
                if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) continue;
                if (!/Address$/.test(k) && !['baseAddress', 'borderColor', 'backgroundColor'].includes(k)) continue;
                layout[k] = '0x' + ((parseInt(v) + codeDeltaAddr) & 0xffff).toString(16).toUpperCase();
            }
            delete layout.binary;
            return {
                codeBlob: img, gfxBlob: new Uint8Array(0), codePage,
                gfxBankBase: codePage, gfxBankNum: 0, splitOff: size, gfxOffset: size, layout,
                xform: (a) => (a + codeDeltaAddr) & 0xffff,
                dataLoadAddress: codePage, visualizerLoadAddress: codePage + 0x100,
            };
        }

        // --- Trim dead padding between the code and the first VIC asset --------
        // The image leaves a gap of zero bytes from the end of the code up to the
        // colour table (the lowest asset). No runtime buffer maps there, so start
        // the graphics blob at the colour table and hand the freed low-bank RAM to
        // the baked codebook/index. Only trim when the config names the colour
        // table AND that gap is genuinely all zero, so we never cut into a real
        // asset (or a player we can't prove the boundary for, e.g. triple-bars).
        let gfxOffset = splitOff;
        const ctBase = baseLayout.colorTableAddress ? parseInt(baseLayout.colorTableAddress) : 0;
        if (ctBase > base + splitOff && ctBase < base + size) {
            const padEnd = ctBase - base;
            let dead = true;
            for (let i = splitOff; i < padEnd; i++) if (baseBin[i] !== 0) { dead = false; break; }
            if (dead) gfxOffset = padEnd;
        }

        // --- Choose the VIC bank to maximise the baked-data block --------------
        // The graphics blob (colour table .. bar chars) is locked to the top of a
        // 16 KB VIC bank; the baked spectrometer is free to sit anywhere in CPU
        // RAM. So try each viable bank and keep the one that leaves the LARGEST
        // contiguous CPU-RAM block for the baked data - high ($C000) when the low
        // RAM is busy, low otherwise. $C000 relies on the VIC reading RAM across
        // the whole bank (including under the $D000-$DFFF I/O window, which the CPU
        // sees as I/O): the trimmed bar-family blob starts above $E000 so nothing
        // lands under I/O, but the dead-under-I/O guard stays for players that
        // reach it, and the blob must stop short of the $FFFA CPU vectors.
        const deadUnderIO = (b) => {
            const lo = Math.max(b + gfxOffset, 0xD000), hi = Math.min(b + size, 0xE000);
            for (let a = lo; a < hi; a++) if (baseBin[a - b] !== 0) return false;
            return true;
        };
        const viable = (b) => {
            const gStart = b + gfxOffset, gEnd = b + size;
            if (gEnd > 0x10000) return false;
            if (b === 0xC000) { if (gEnd > 0xFFFA || !deadUnderIO(b)) return false; }
            else if (gEnd > 0xD000) return false;                     // stay below I/O
            if (gStart < sidEnd && sidStart < gEnd) return false;     // overlaps SID
            // The VIC reads the character ROM at $1000-$1FFF and $9000-$9FFF, so no
            // VIC-fetched graphics (screen/charset/bitmap/sprites) may sit there - it
            // would show the ROM font instead of RAM. Banks 0 and 2 expose it; graphics
            // that start at/above bank+$2000 clear it (the bar players), so this only
            // bites a player like MusicalBlobs whose screen sits at bank+$1800.
            for (const romLo of [0x1000, 0x9000]) if (gStart < romLo + 0x1000 && romLo < gEnd) return false;
            return true;
        };
        let gfxBankBase = null, codePage = null, bestScore = -1;
        for (const b of [0xC000, 0x8000, 0x4000]) {
            if (!viable(b)) continue;
            const gfxRes = { start: b + gfxOffset, end: b + size };
            const cp = chooseCodePage(splitOff, gfxRes);
            if (cp === null) continue;                 // no free page for code with this bank
            const score = this.largestFreeCpuBlock([
                { start: sidStart, end: sidEnd },
                { start: cp, end: cp + splitOff },
                gfxRes,
            ]);
            if (score > bestScore) { bestScore = score; gfxBankBase = b; codePage = cp; }
        }
        if (gfxBankBase === null) throw new Error('Relocation: no free VIC bank for graphics');
        const gfxBankNum = gfxBankBase / 0x4000;

        const codeDeltaPg = ((codePage - base) >> 8) & 0xff;
        const gfxDeltaPg = ((gfxBankBase - base) >> 8) & 0xff;

        const img = new Uint8Array(baseBin);
        for (const o of table.codeRefs) img[o] = (img[o] + codeDeltaPg) & 0xff;
        for (const o of table.gfxRefs) img[o] = (img[o] + gfxDeltaPg) & 0xff;
        for (const a of table.anomalies) img[a.off] = (a.base + a.perBank * (gfxBankNum - 1)) & 0xff;

        // Transform every address field in the layout: code/data region gets the
        // code delta, graphics region gets the bank delta.
        const codeDeltaAddr = codePage - base, gfxDeltaAddr = gfxBankBase - base;
        const layout = { ...baseLayout };
        for (const k of Object.keys(layout)) {
            const v = layout[k];
            if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) continue;
            if (!/Address$/.test(k) && !['baseAddress', 'borderColor', 'backgroundColor'].includes(k)) continue;
            const n = parseInt(v);
            layout[k] = '0x' + ((n < split ? n + codeDeltaAddr : n + gfxDeltaAddr) & 0xffff).toString(16).toUpperCase();
        }
        delete layout.binary;                    // two relocated blobs, not one fixed binary

        // Region transform for any other absolute address (e.g. logo input targets):
        // below the split moves with the code, at/above it with the graphics.
        const xform = (addr) => (addr < split ? addr + codeDeltaAddr : addr + gfxDeltaAddr) & 0xffff;

        return {
            codeBlob: img.slice(0, splitOff), gfxBlob: img.slice(gfxOffset),
            codePage, gfxBankBase, gfxBankNum, splitOff, gfxOffset, layout, xform,
            dataLoadAddress: codePage, visualizerLoadAddress: codePage + 0x100,
        };
    }

    // Code-only relocation planner (no side effects). Like planRelocation, but the
    // code comes from a standalone CODE_ONLY build (`codeBin`, based at
    // codeTable.base, no graphics -> not capped below the bitmap) and the graphics
    // come from a bank4000 image (`gfxBin`, composed from the player's graphics
    // manifest by loadGfxManifest). Code and
    // graphics are placed INDEPENDENTLY using the two-diff table from
    // gen-reloc-codeonly.js: code refs move with the chosen page, gfx refs with the
    // chosen bank. The graphics blob is raw VIC data (the bar family bakes no address
    // pointers into it), so it needs no patching. The layout config is bank4000-
    // relative in both paths, so its address transform is identical to planRelocation.
    planRelocationCodeOnly(codeTable, codeBin, gfxBin, baseLayout, actualSidAddress, sidDataLength, chooseCodePage) {
        // The table's byte offsets are only meaningful against the exact blob
        // it was generated with (they're regenerated together by the build).
        // A size mismatch means one of the two is stale - relocating anyway
        // would patch the wrong bytes and corrupt the player code, so refuse
        // (the caller falls back to the self-consistent fixed-bank binary).
        if (codeTable.size != null && codeBin.length !== codeTable.size) {
            throw new Error(`code blob (${codeBin.length}B) doesn't match its reloc table (${codeTable.size}B) - stale cached file?`);
        }
        if (codeTable.adler32 != null) {
            let a = 1, b = 0;
            for (let i = 0; i < codeBin.length; i++) { a = (a + codeBin[i]) % 65521; b = (b + a) % 65521; }
            if ((((b << 16) | a) >>> 0) !== codeTable.adler32) {
                throw new Error('code blob checksum doesn\'t match its reloc table - stale cached file?');
            }
        }
        const CODE_BASE = codeTable.base;         // $1000 (CODE_ONLY build base)
        const CFG_BASE = 0x4000;                  // layout config + gfxBin are bank4000
        const size = gfxBin.length;               // 16 KB graphics-source image
        const codeLen = codeBin.length;
        const sidStart = actualSidAddress, sidEnd = actualSidAddress + sidDataLength;

        // Graphics blob starts at the lowest VIC asset; everything below it in gfxBin
        // is the graphics build's own code, which we discard. graphicsBase names that
        // address explicitly (players with no colour table, e.g. MusicalBlobs); it
        // defaults to the colour table for players that keep it as the lowest asset.
        const gBase = baseLayout.graphicsBase ? parseInt(baseLayout.graphicsBase)
            : (baseLayout.colorTableAddress ? parseInt(baseLayout.colorTableAddress) : 0);
        if (!(gBase > CFG_BASE && gBase < CFG_BASE + size)) {
            throw new Error('Relocation (code-only): graphicsBase/colorTableAddress required to locate the graphics blob');
        }
        const gfxOffset = gBase - CFG_BASE;

        // Bank + code-page choice: identical scoring to planRelocation (maximise the
        // largest free CPU block for the baked FFT data).
        const deadUnderIO = (b) => {
            const lo = Math.max(b + gfxOffset, 0xD000), hi = Math.min(b + size, 0xE000);
            for (let a = lo; a < hi; a++) if (gfxBin[a - b] !== 0) return false;
            return true;
        };
        const viable = (b) => {
            const gStart = b + gfxOffset, gEnd = b + size;
            if (gEnd > 0x10000) return false;
            if (b === 0xC000) { if (gEnd > 0xFFFA || !deadUnderIO(b)) return false; }
            else if (gEnd > 0xD000) return false;
            if (gStart < sidEnd && sidStart < gEnd) return false;
            // VIC char-ROM shadow at $1000-$1FFF / $9000-$9FFF - no VIC graphics there.
            for (const romLo of [0x1000, 0x9000]) if (gStart < romLo + 0x1000 && romLo < gEnd) return false;
            return true;
        };
        let gfxBankBase = null, codePage = null, bestScore = -1;
        for (const b of [0xC000, 0x8000, 0x4000]) {
            if (!viable(b)) continue;
            const gfxRes = { start: b + gfxOffset, end: b + size };
            const cp = chooseCodePage(codeLen, gfxRes);
            if (cp === null) continue;                 // no free page for code with this bank
            const score = this.largestFreeCpuBlock([
                { start: sidStart, end: sidEnd },
                { start: cp, end: cp + codeLen },
                gfxRes,
            ]);
            if (score > bestScore) { bestScore = score; gfxBankBase = b; codePage = cp; }
        }
        if (gfxBankBase === null) throw new Error('Relocation (code-only): no free VIC bank for graphics');
        const gfxBankNum = gfxBankBase / 0x4000;

        // Patch the code image: code refs by the page delta (from CODE_BASE), gfx
        // refs by the bank delta (the CODE_ONLY build put graphics in bank 1 = $4000),
        // VIC-config anomalies recomputed for the chosen bank.
        const codeDeltaPg = ((codePage - CODE_BASE) >> 8) & 0xff;
        const gfxDeltaPg = ((gfxBankBase - 0x4000) >> 8) & 0xff;
        const code = new Uint8Array(codeBin);
        for (const o of codeTable.codeRefs) code[o] = (code[o] + codeDeltaPg) & 0xff;
        for (const o of codeTable.gfxRefs) code[o] = (code[o] + gfxDeltaPg) & 0xff;
        for (const a of (codeTable.anomalies || [])) code[a.off] = (a.base + a.perBank * (gfxBankNum - 1)) & 0xff;

        const gfxBlob = gfxBin.slice(gfxOffset);

        // Code/graphics boundary for the address transform (and the logo-input
        // xform): the LOWEST graphics asset. Defaults to the colour table, which is
        // correct when nothing graphics-y sits below it (the no-logo players). A logo
        // player whose bitmap sits below the colour table sets relocSplit to that
        // bitmap address, so the bitmap + logo-screen/colour inputs classify as
        // graphics (bank delta), not code.
        const split = baseLayout.relocSplit ? parseInt(baseLayout.relocSplit) : (CFG_BASE + gfxOffset);
        const codeDeltaAddr = codePage - CFG_BASE, gfxDeltaAddr = gfxBankBase - CFG_BASE;
        const layout = { ...baseLayout };
        for (const k of Object.keys(layout)) {
            const v = layout[k];
            if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) continue;
            if (!/Address$/.test(k) && !['baseAddress', 'borderColor', 'backgroundColor'].includes(k)) continue;
            const n = parseInt(v);
            layout[k] = '0x' + ((n < split ? n + codeDeltaAddr : n + gfxDeltaAddr) & 0xffff).toString(16).toUpperCase();
        }
        delete layout.binary;
        const xform = (addr) => (addr < split ? addr + codeDeltaAddr : addr + gfxDeltaAddr) & 0xffff;

        return {
            codeBlob: code, gfxBlob, codePage, gfxBankBase, gfxBankNum,
            splitOff: codeLen, gfxOffset, layout, xform,
            dataLoadAddress: codePage, visualizerLoadAddress: codePage + 0x100,
        };
    }

    // Split the relocated graphics blob into labelled sub-regions for the memory
    // map (purely descriptive - the bytes/addresses are unchanged, just itemised).
    // The graphics image is code-end padding + colour table + sprites/screens +
    // charset + bar chars; the leading padding is dead space (assembler gap) and
    // the colour table is CPU-only ($D800 setup), which is exactly the memory the
    // packing work will reclaim. Derived per build from the leading zero run plus
    // this player's (relocated) layout addresses, so it spans the whole bar family
    // and returns null (single opaque block) when it can't split confidently.
    graphicsSubComponents(blob, gStart, layout) {
        const gEnd = gStart + blob.length;

        // Preferred: an explicit per-player segment map, offsets from the graphics
        // blob start (= gStart), transcribed from the assembler's named segments
        // (KickAss -showmem). Each entry is {name, off, len}; gaps between segments
        // fall through as the map's hatched "unused" background. The map's overlap
        // resolution folds away whatever an input (e.g. a bitmap logo) overwrites,
        // so a segment fully under the logo just disappears in favour of it.
        const P = (v) => (typeof v === 'string' ? parseInt(v) : v);
        if (Array.isArray(layout.graphicsSegments) && layout.graphicsSegments.length) {
            const segs = [];
            for (const s of layout.graphicsSegments) {
                const addr = gStart + P(s.off);
                const end = Math.min(addr + P(s.len), gEnd);
                if (end > addr) segs.push({ name: s.name, addr, data: blob.subarray(addr - gStart, end - gStart) });
            }
            if (segs.length) return segs;
        }

        const A = (v) => { const n = typeof v === 'string' ? parseInt(v) : v; return Number.isFinite(n) ? n : null; };
        const ct = A(layout.colorTableAddress);   // colour table (lowest asset)
        const cs = A(layout.charsetAddress);       // charset start
        // Regions in address order, each a superset of the fine option patches
        // inside it so those fold away in the map. When the dead padding has been
        // trimmed (planRelocation), the colour table sits at gStart and the
        // padding region is simply absent.
        const out = [];
        const push = (s, e, name) => { if (e > s) out.push({ name, addr: s, data: blob.subarray(s - gStart, e - gStart) }); };
        let cur = gStart;
        if (ct && ct > gStart && ct < gEnd) {
            // Something sits below the colour table. Either it's dead assembler
            // padding (untrimmed classic reloc - reclaimable) or it's real data: the
            // mirror players park their curtain sprite in the 64-byte gap just below
            // the colour table (graphicsBase points at it). Tell the two apart by
            // content so the map names the sprite instead of a vague "data" blob.
            let allZero = true;
            for (let i = 0; i < ct - gStart; i++) if (blob[i] !== 0) { allZero = false; break; }
            push(cur, ct, allZero ? 'Graphics: padding (unused, reclaimable)' : 'Graphics: sprite data');
            cur = ct;
        }
        if (cs && cs > cur && cs < gEnd) {
            // No per-segment map for this player, so everything from the colour
            // table (or the graphics start) up to the charset stays one coarse
            // block - it holds the CPU-read colour table ($D800 source) and the
            // VIC screen RAM. It's deliberately NOT called "sprites": the sprite
            // *pointers* live inside screen RAM and, without the segment map, the
            // map can't tell those apart from actual sprite pixel data. Players
            // that need the fine breakdown carry a graphicsSegments map (handled
            // above); this label is only the fallback when they don't.
            push(cur, cs, (ct && ct <= cur)
                ? 'Graphics: colour table → $D800 + screen RAM'
                : 'Graphics: screen RAM');
            cur = cs;
        }
        push(cur, gEnd, 'Graphics: charset + bar chars');
        return out.length >= 2 ? out : null;
    }

    // Compose a bank image from a graphics manifest (gen-gfx-manifest.js): a
    // zero-filled buffer of the declared size, with each base64 payload written
    // at its bank offset. Reservation segments (no data) stay zero - they only
    // document extent. The result is byte-equivalent to the old GFX_DONOR bank
    // .bin over everything the exporter reads, so it slots straight into
    // planRelocationCodeOnly as the graphics source.
    async loadGfxManifest(url) {
        // no-cache for the same reason as loadBinaryFile: the manifest is
        // regenerated together with the code blob + reloc table.
        const resp = await fetch(url, { cache: 'no-cache' });
        if (!resp.ok) throw new Error(`Failed to load ${url}: ${resp.statusText}`);
        const m = await resp.json();
        const base = parseInt(m.base), size = parseInt(m.size);
        if (!(base >= 0 && size > 0 && size <= 0x10000)) throw new Error(`${url}: bad base/size`);
        const img = new Uint8Array(size);
        for (const s of (m.segments || [])) {
            if (!s.data) continue;
            const off = parseInt(s.addr) - base;
            const bytes = Uint8Array.from(atob(s.data), c => c.charCodeAt(0));
            if (bytes.length !== parseInt(s.size) || off < 0 || off + bytes.length > size) {
                throw new Error(`${url}: segment ${s.addr} is inconsistent - regenerate the manifest`);
            }
            img.set(bytes, off);
        }
        return img;
    }

    // Relocatable export: place the SID, the relocated code + graphics blobs, and
    // return the transformed layout. Graphics stay in a VIC bank; code goes on any
    // free page. (Currently wired for the no-input players, e.g. RaistlinBars.)
    async placeRelocatedVisualizer(vizConfig, actualSidAddress, sidData) {
        const baseLayout = vizConfig.layouts[vizConfig.relocBaseLayout || 'bank4000'];

        // SID first so the code-page search avoids it.
        this.builder.addComponent(sidData, actualSidAddress, 'SID Music');

        const chooseCodePage = (needed, gfxReserve) =>
            this.findSafeMemoryForRoutines(needed, actualSidAddress, sidData.length, gfxReserve ? [gfxReserve] : []);

        let plan;
        if (vizConfig.relocCodeBase) {
            // Code-only path: a standalone CODE_ONLY code blob (no graphics, so its
            // code isn't capped below the bitmap) plus a bank4000 graphics image,
            // placed independently via the two-diff table (gen-reloc-codeonly.js).
            const codeTable = await (await fetch(vizConfig.relocCodeTable, { cache: 'no-cache' })).json();
            const codeBin = await this.loadBinaryFile(vizConfig.relocCodeBase);
            // Graphics source: composed from the generated manifest. (A config
            // may instead still name a donor bank .bin via relocBase - the
            // pre-manifest source format.)
            const gfxBin = vizConfig.gfxManifest
                ? await this.loadGfxManifest(vizConfig.gfxManifest)
                : await this.loadBinaryFile(vizConfig.relocBase);

            // Shadow players: the SID-mirror page + replay-order addresses come from
            // the reloc table (derived from the live labels at build time), not from
            // hand-maintained config constants that silently drift and corrupt the
            // export. Fold them into the base layout so the reloc transform relocates
            // them with everything else.
            let effBaseLayout = baseLayout;
            if (vizConfig.spectrometerShadow) {
                if (!codeTable.shadowMirror || !codeTable.shadowOrder) {
                    throw new Error(`${vizConfig.relocCodeTable}: shadow player is missing shadowMirror/shadowOrder ` +
                        `- regenerate the reloc table (gen-reloc-codeonly.js).`);
                }
                effBaseLayout = { ...baseLayout,
                    shadowMirrorAddress: codeTable.shadowMirror,
                    shadowOrderAddress: codeTable.shadowOrder };
            }
            plan = this.planRelocationCodeOnly(codeTable, codeBin, gfxBin, effBaseLayout, actualSidAddress, sidData.length, chooseCodePage);
        } else {
            const table = await (await fetch(vizConfig.relocTable, { cache: 'no-cache' })).json();
            const baseBin = await this.loadBinaryFile(vizConfig.relocBase);
            plan = this.planRelocation(table, baseBin, baseLayout, actualSidAddress, sidData.length, chooseCodePage);
        }

        this.builder.addComponent(plan.codeBlob, plan.codePage, 'Visualizer Code');
        if (plan.gfxBlob.length > 0) {
            const gStart = plan.gfxBankBase + plan.gfxOffset;
            // Itemise the graphics blob in the memory map instead of one opaque
            // "Visualizer Graphics" block: the CPU-only colour table + VIC screen
            // RAM, the charset and the bar chars (the dead padding below the colour
            // table is trimmed off in planRelocation, so it shows as free RAM).
            // Falls back to a single component when it can't split.
            const parts = this.graphicsSubComponents(plan.gfxBlob, gStart, plan.layout);
            if (parts) {
                for (const part of parts) this.builder.addComponent(part.data, part.addr, part.name);
            } else {
                this.builder.addComponent(plan.gfxBlob, gStart, 'Visualizer Graphics');
            }
        }
        this.lastSysAddress = plan.visualizerLoadAddress;

        console.log(`Reloc: code@$${plan.codePage.toString(16)} (${plan.codeBlob.length}B), ` +
            `graphics@$${(plan.gfxBankBase + plan.gfxOffset).toString(16)} (VIC bank ${plan.gfxBankNum}, ${plan.gfxBlob.length}B), ` +
            `SID@$${actualSidAddress.toString(16)}`);
        return plan;
    }

    // Patch a player's data-block song-length fields (bakedLenMin/Sec + bakedHasLength)
    // from the on-load loop analysis, reusing that result rather than rendering again.
    // Used for the non-spectrometer players (RaistlinBars live, Default, ...) - the
    // spectrometer path derives the length from its own bake instead. Length is shown
    // only for a single-song SID with a detected loop; otherwise the fields stay 0 and
    // the player keeps the timer alone. No-op if the layout lacks the addresses.
    //
    // When the layout also exposes the loop-triple fields (Default/DefaultWithLogo),
    // emit the frame-exact loop geometry so the player's timer WRAPS at the loop
    // instead of running past the length. The elapsed clock already carries an exact
    // frame position as MM:SS:frame (a sub-second FrameCounter). We give the player
    // two triples: the loop END (when the clock's MM:SS:frame reaches it, wrap) and
    // the loop START (the triple to snap back to). Comparing/resetting on the frame
    // counter itself means the wrap is frame-exact with no cumulative drift.
    // forcedLoopFrames (non-zero = the forced-song-loop restart point in raster
    // frames, for a fade-out tune the user chose to loop): the clock gets a real
    // length equal to the restart point and wraps to 0:00:00 - the exact frame
    // the shared player code re-inits the tune (both count the same IRQ frames).
    // opts.show=false: the user asked for no length on screen, so every field is
    // zeroed exactly as if none had been found.
    // opts.manualSeconds: a length the user typed rather than one the scan
    // measured. Treated as the tune's period - the clock counts to it and wraps
    // to 0:00, the same geometry a forced loop gets, but WITHOUT re-initialising
    // the music (lastMusicLoopFrames stays whatever the caller set). Never write
    // a length without a loop end: CheckLoopWrap (INC/timer.asm) compares the
    // clock against bakedLoopEnd* and would wrap on the very first frame.
    patchSongLengthFields(layout, tuneAnalysis, multiSong, forcedLoopFrames = 0, opts = {}) {
        if (!layout || !layout.bakedHasLengthAddress) return;
        const byte = (v) => new Uint8Array([v & 0xFF]);
        const show = opts.show !== false;
        const manualSeconds = Math.max(0, Math.floor(opts.manualSeconds || 0));
        const looped = !!(tuneAnalysis && tuneAnalysis.looped);
        const forced = forcedLoopFrames > 0 && !multiSong;
        const manual = manualSeconds > 0 && !multiSong;
        const hasLength = (show && (looped || forced || manual) && !multiSong) ? 1 : 0;

        // No length to show (multi-song, no loop, or analysis skipped): explicitly
        // ZERO every length/loop byte. The injected data block writes the SID
        // copyright string across $50-$6F, which overlaps these fields ($5B-$5F),
        // so leaving them unpatched lets the player draw a bogus "/MM:SS" from
        // copyright characters (e.g. a multi-song tune reading "56:54").
        if (!hasLength) {
            for (const a of [layout.bakedLenMinAddress, layout.bakedLenSecAddress,
                layout.bakedLoopMinAddress, layout.bakedLoopSecAddress, layout.bakedLoopFrameRemAddress,
                layout.bakedLoopEndMinAddress, layout.bakedLoopEndSecAddress, layout.bakedLoopEndFrameRemAddress]) {
                if (a) this.builder.addComponent(byte(0), parseInt(a), 'Song length (none)');
            }
            this.builder.addComponent(byte(0), parseInt(layout.bakedHasLengthAddress), 'Song Has Length');
            return;
        }

        // Player timer fps (integer): the elapsed clock counts these per second.
        // A typed length can be the only thing we have, so nothing below may
        // assume an analysis exists.
        const fps = (tuneAnalysis && tuneAnalysis.isNtsc) ? 60 : 50;
        // Loop geometry in RAW raster frames. The analysis loop points are in
        // keyframes at keyframeHz; one keyframe = step raster frames. A forced
        // loop always restarts from the very beginning: start 0, end = restart,
        // and so does a typed length (the user is stating the tune's period).
        const step = tuneAnalysis
            ? Math.max(1, Math.round((tuneAnalysis.frameHz || fps) / (tuneAnalysis.keyframeHz || (fps / 2))))
            : 1;
        // A measured loop wins over a typed one - the user can clear the field if
        // they disagree with it.
        const loopEndFrames = forced ? forcedLoopFrames
            : looped ? Math.max(0, Math.round((tuneAnalysis.numKeyframes || 0) * step))
                : manualSeconds * fps;
        const loopStartFrames = (forced || (manual && !looped)) ? 0
            : Math.max(0, Math.round(((tuneAnalysis && tuneAnalysis.loopStart) || 0) * step));

        // Decompose a raw-frame count into the displayed MM:SS + intra-second frame.
        const triple = (frames) => {
            const tot = Math.floor(frames / fps);
            return {
                m: Math.min(99, Math.floor(tot / 60)),
                s: Math.min(59, tot % 60),
                rem: frames % fps,
            };
        };
        const end = triple(loopEndFrames);
        const start = triple(loopStartFrames);

        // The displayed length is the loop-end timestamp: the clock reaches exactly
        // MM:SS at the wrap frame and then snaps back, so the shown length and the
        // wrap agree (the clock never runs past it).
        if (layout.bakedLenMinAddress) this.builder.addComponent(byte(hasLength ? end.m : 0), parseInt(layout.bakedLenMinAddress), 'Song Length Minutes');
        if (layout.bakedLenSecAddress) this.builder.addComponent(byte(hasLength ? end.s : 0), parseInt(layout.bakedLenSecAddress), 'Song Length Seconds');
        this.builder.addComponent(byte(hasLength), parseInt(layout.bakedHasLengthAddress), 'Song Has Length');

        // Loop-wrap triples (Default family). Zeroed when there's no usable loop,
        // so the player just counts up as before.
        if (layout.bakedLoopEndMinAddress) {
            if (layout.bakedLoopMinAddress) this.builder.addComponent(byte(hasLength ? start.m : 0), parseInt(layout.bakedLoopMinAddress), 'Loop Start Minutes');
            if (layout.bakedLoopSecAddress) this.builder.addComponent(byte(hasLength ? start.s : 0), parseInt(layout.bakedLoopSecAddress), 'Loop Start Seconds');
            if (layout.bakedLoopFrameRemAddress) this.builder.addComponent(byte(hasLength ? start.rem : 0), parseInt(layout.bakedLoopFrameRemAddress), 'Loop Start Frame');
            this.builder.addComponent(byte(hasLength ? end.m : 0), parseInt(layout.bakedLoopEndMinAddress), 'Loop End Minutes');
            if (layout.bakedLoopEndSecAddress) this.builder.addComponent(byte(hasLength ? end.s : 0), parseInt(layout.bakedLoopEndSecAddress), 'Loop End Seconds');
            if (layout.bakedLoopEndFrameRemAddress) this.builder.addComponent(byte(hasLength ? end.rem : 0), parseInt(layout.bakedLoopEndFrameRemAddress), 'Loop End Frame');
        }
    }

    // Returns { data: Uint8Array, compressed: boolean }. `compressed` reflects
    // what actually happened, not what was requested - callers must label the
    // file from it, never from the requested compression type.
    async createPRG(options = {}) {
        const {
            sidLoadAddress = null,
            sidInitAddress = null,
            sidPlayAddress = null,
            preferredAddress = null,
            visualizerFile = 'prg/TextInput.bin',
            compressionType = 'exomizer',
            maxCallsPerFrame = null,
            visualizerId = null,
            selectedSong = 0,
            tuneAnalysis = null,
            bakeParams = null,
            forceSongLoop = false,
            // Song length shown on the C64: the user can suppress it, or state it
            // themselves instead of waiting for the scan to measure it.
            showSongLength = true,
            manualLengthSeconds = 0
        } = options;

        try {
            this.builder.clear();
            this.lastBakeInfo = null;   // only set when a baked-spectrometer export runs
            this.lastMusicLoopFrames = 0;   // forced-song-loop restart (frames); 0 = off
            this.lastLogoIsBitmap = false;  // set by convertLogoPNG when a logo converts as bitmap

            const sidInfo = this.extractSIDMusicData();

            let header = null;
            if (this.analyzer.sidHeader) {
                header = this.analyzer.sidHeader;
            } else {
                const modifiedSID = this.analyzer.createModifiedSID();
                if (modifiedSID) {
                    header = await this.analyzer.loadSID(modifiedSID);
                    this.analyzer.sidHeader = header;
                }
            }

            if (!header) {
                header = {
                    name: 'Unknown',
                    author: 'Unknown',
                    copyright: '',
                    songs: 1,
                    clockType: 'PAL',
                    sidModel: '6581',
                    fileSize: sidInfo.data.length
                };
            }

            // Load visualizer config and select layout
            const config = new VisualizerConfig();
            const visualizerName = visualizerId || visualizerFile.replace('prg/', '').replace('.bin', '');
            const vizConfig = await config.loadConfig(visualizerName);
            const configMaxCallsPerFrame = vizConfig?.maxCallsPerFrame || null;

            // Get modified addresses for layout validation
            const modifiedAddresses = this.analyzer.analysisResults?.modifiedAddresses || null;
            const modifiedCount = modifiedAddresses?.length || 0;

            const actualSidAddress = (sidLoadAddress != null) ? sidLoadAddress : sidInfo.loadAddress;
            const actualInitAddress = (sidInitAddress != null) ? sidInitAddress : actualSidAddress;
            const actualPlayAddress = (sidPlayAddress != null) ? sidPlayAddress : (actualSidAddress + 3);

            let layout, dataLoadAddress, visualizerLoadAddress, layoutKey = options.layoutKey;
            // relocLayout, when set, is a per-address-transformed layout that the
            // option-patching pass must use instead of the config's fixed one;
            // relocXform transforms any other absolute address (e.g. logo inputs).
            let relocLayout = null, relocXform = null;

            // Relocated export: place the SID + relocated code/graphics blobs and use
            // the transformed layout downstream.
            //
            // Code-only players (relocCodeBase) have NO fixed-bank fallback: they
            // ship no runnable bank binary at all (code lives in the reloc blob,
            // graphics in the manifest) precisely so code size is never capped by
            // the bank layout - so a relocation failure is a real error, not a
            // detour. It can
            // only genuinely happen when the SID tramples every candidate VIC bank,
            // in which case a fixed bank could not have worked either.
            //
            // Full-binary reloc players (relocTable: ScrapColumns, SimpleRaster)
            // keep runnable bank builds and the fixed-bank fallback.
            let useReloc = false;
            if (vizConfig?.relocatable) {
                try {
                    const plan = await this.placeRelocatedVisualizer(vizConfig, actualSidAddress, sidInfo.data);
                    layout = plan.layout;
                    relocLayout = plan.layout;
                    relocXform = plan.xform;
                    dataLoadAddress = plan.dataLoadAddress;
                    visualizerLoadAddress = plan.visualizerLoadAddress;
                    layoutKey = vizConfig.relocBaseLayout || 'bank4000';
                    this.lastLayoutKey = 'reloc';
                    useReloc = true;
                } catch (relocErr) {
                    if (vizConfig.relocCodeBase) {
                        throw new Error(`Cannot place this visualizer around the SID: ${relocErr.message}`);
                    }
                    console.warn(`Relocation unavailable (${relocErr.message}); using a fixed bank.`);
                    this.builder.clear();   // drop anything the reloc attempt placed (the SID)
                }
            }

            if (!useReloc) {
                // Get the layout key from options (passed from UI) or select first valid one
                if (!layoutKey) {
                    const modifiedAddresses = this.analyzer.analysisResults?.modifiedAddresses || null;
                    const validLayouts = this.selectValidLayouts(vizConfig, sidInfo.loadAddress, sidInfo.dataSize, modifiedAddresses);
                    const firstValid = validLayouts.find(l => l.valid);
                    if (!firstValid) {
                        throw new Error(`No valid layout found for visualizer ${visualizerName}`);
                    }
                    layoutKey = firstValid.key;
                }

                layout = vizConfig?.layouts?.[layoutKey];
                if (!layout) {
                    throw new Error(`No valid layout found for visualizer ${visualizerName}`);
                }

                dataLoadAddress = parseInt(layout.dataAddress);
                visualizerLoadAddress = parseInt(layout.sysAddress);
                // Expose the bank the builder actually chose (layoutKey may have been
                // auto-selected) so the UI can name/label the export correctly.
                this.lastSysAddress = visualizerLoadAddress;
                this.lastLayoutKey = layoutKey;

                // Add SID music
                this.builder.addComponent(sidInfo.data, actualSidAddress, 'SID Music');

                if (layout.binary) {
                    const visualizerBytes = await this.loadBinaryFile(layout.binary);
                    const binaryLoadAddress = parseInt(layout.binaryDataStart || layout.baseAddress);
                    this.builder.addComponent(visualizerBytes, binaryLoadAddress, 'Visualizer Binary');
                }
            }

            // Shadow-register method: repoint the tune's $D4xx stores at the
            // player's mirror page and bake the canonical replay order.
            if (vizConfig?.spectrometerShadow) {
                await this.processSpectrometerShadow(vizConfig, layout, sidInfo, header, selectedSong);
            }

            // Process additional visualizer inputs. Priority 1: a user input (e.g.
            // a bitmap logo) is placed ON TOP of the base graphics, so it wins over
            // any overlapping base bytes even when a base component sits at a higher
            // load address (the split graphics blob).
            const additionalComponents = await this.processVisualizerInputs(visualizerName, layoutKey, relocXform);
            for (const component of additionalComponents) {
                this.builder.addComponent(component.data, component.loadAddress, component.name, 1, component.hidden);
            }

            // Process visualizer options BEFORE calculating save/restore addresses
            // This ensures we know where all visualizer data is placed. Priority 2:
            // option patches are written last of all, overriding inputs and base.
            const optionComponents = await this.processVisualizerOptions(visualizerName, layoutKey, relocLayout);
            for (const component of optionComponents) {
                this.builder.addComponent(component.data, component.loadAddress, component.name, 2);
            }

            // Pick the bank-0 intro screen page now that every memory component
            // (SID, visualizer, inputs, options) has been placed, so the intro
            // never overwrites a low-loading SID.
            const introScreenHi = this.computeIntroScreenHi();
            const introScreenRange = { start: introScreenHi << 8, end: (introScreenHi << 8) + 0x400 };

            // Baked FFT spectrometer: precompute the bar-height stream for this tune
            // and place it (codebook + index) in free RAM, then patch the player's
            // data-block pointers so it replays instead of analysing. This must run
            // LATE - after the SID, player, inputs, options and intro-screen page are
            // all registered - so findSafeMemoryForRoutines avoids every one of them.
            // The codebook+index stream is largest at 50 fps; placing it before the
            // inputs/intro page would let it overlap a component registered afterwards,
            // which the build() merger resolves silently by address order (corrupt PRG).
            // Forced song loop (user option, fade-out tunes only): single-song SIDs
            // only - on a multi-song export the detected length belongs to one song
            // and the user can switch songs at runtime.
            const multiSong = !!(header && header.songs > 1);
            const wantForceLoop = !!forceSongLoop && !multiSong;

            if (vizConfig?.spectrometerBake) {
                await this.processSpectrometerBake(vizConfig, layout, actualSidAddress, sidInfo.data.length, selectedSong, options.onProgress, [introScreenRange], bakeParams, wantForceLoop);
            } else {
                // Non-baked players: turn the analysis' fade-out point into a raster
                // frame count. The shared player code counts frames and re-inits the
                // tune when the count expires; the restart lands ~1 s after the last
                // audible frame so the fade can breathe.
                if (wantForceLoop && tuneAnalysis && !tuneAnalysis.looped && tuneAnalysis.fadedOut) {
                    const fps = tuneAnalysis.isNtsc ? 60 : 50;
                    const step = Math.max(1, Math.round((tuneAnalysis.frameHz || fps) / (tuneAnalysis.keyframeHz || (fps / 2))));
                    const endFrames = Math.round((tuneAnalysis.loopStart || 0) * step);  // last audible keyframe (fade path: loopStart = musicEnd)
                    if (endFrames > 0) {
                        this.lastMusicLoopFrames = Math.min(0xFFFFFF, endFrames + fps);
                    }
                }
                // Non-spectrometer players show the song length too, reusing the on-load
                // analysis (single-song only) instead of rendering. No-op unless the
                // player's layout exposes the length fields.
                this.patchSongLengthFields(layout, tuneAnalysis, multiSong, this.lastMusicLoopFrames,
                    { show: showSongLength, manualSeconds: manualLengthSeconds });
            }

            // Check if this visualizer needs save/restore functionality
            const needsSaveRestore = vizConfig?.needsSaveRestore !== false;

            // Place save/restore routines in safe memory (only if needed)
            // The data block contains JMPs that point directly to these routines,
            // or RTS instructions if save/restore is not needed
            let saveRoutineAddr = 0;
            let restoreRoutineAddr = 0;

            if (needsSaveRestore && this.analyzer.analysisResults && this.analyzer.analysisResults.modifiedAddresses) {
                const modifiedAddrs = Array.from(this.analyzer.analysisResults.modifiedAddresses);

                // Calculate the routine size FIRST to know how much space we need
                const routineSizes = this.calculateSaveRestoreSize(modifiedAddrs);
                const totalRoutineSize = routineSizes.totalSize;

                // Find a safe address that can fit the routines without overflowing
                // (keeping clear of the intro screen page reserved above)
                let safeAddress = this.findSafeMemoryForRoutines(totalRoutineSize, actualSidAddress, sidInfo.data.length, [introScreenRange]);
                if (safeAddress === null) {
                    throw new Error(
                        `No free RAM for the ${totalRoutineSize}-byte save/restore routines ` +
                        `(this tune self-modifies ${routineSizes.addressCount} memory locations). ` +
                        `Try a shorter tune, a different memory layout, or a visualizer that needs no save/restore.`);
                }

                // Generate routines to get their actual sizes
                const restoreRoutine = this.generateOptimizedRestoreRoutine(modifiedAddrs);

                // Place restore routine first, at safe address
                restoreRoutineAddr = safeAddress;

                // Place save routine after restore routine
                saveRoutineAddr = restoreRoutineAddr + restoreRoutine.length;

                // Regenerate save routine with correct restore address
                const finalSaveRoutine = this.generateOptimizedSaveRoutine(modifiedAddrs, restoreRoutineAddr);

                // Add the actual routines - data block JMPs point directly to these
                this.builder.addComponent(restoreRoutine, restoreRoutineAddr, 'Restore Routine');
                this.builder.addComponent(finalSaveRoutine, saveRoutineAddr, 'Save Routine');
            }
            // When needsSaveRestore is false, we don't add any components - the data block
            // will contain RTS instructions directly at the save/restore entry points

            const numCallsPerFrame = this.analyzer.analysisResults?.numCallsPerFrame || 1;
            const sidChipCount = this.analyzer.analysisResults?.sidChipCount || 1;

            // The data block contains JMPs to save/restore routines, or RTS if not needed
            const dataBlock = this.generateDataBlock(
                {
                    initAddress: actualInitAddress,
                    playAddress: actualPlayAddress,
                    loadAddress: actualSidAddress,
                    dataSize: sidInfo.dataSize
                },
                this.analyzer.analysisResults,
                header,
                saveRoutineAddr,
                restoreRoutineAddr,
                numCallsPerFrame,
                configMaxCallsPerFrame,
                selectedSong,
                modifiedCount,
                sidChipCount,
                needsSaveRestore,
                introScreenHi,
                this.lastMusicLoopFrames
            );

            this.builder.addComponent(dataBlock, dataLoadAddress, 'Data Block');

            // Build PRG
            const prgData = this.builder.build();

            this.saveRoutineAddress = saveRoutineAddr;
            this.restoreRoutineAddress = restoreRoutineAddr;

            // Apply compression if requested. The return value always reports the
            // ACTUAL state: on any failure (compressor missing or throwing) the
            // caller gets the working uncompressed image with compressed:false, so
            // it names/labels the file honestly instead of handing the user a raw
            // multi-segment PRG (no BASIC stub, won't RUN) labelled "compressed".
            if (compressionType !== 'none') {
                try {
                    if (!this.compressorManager) {
                        this.compressorManager = new CompressorManager();
                    }

                    await this.compressorManager.waitForInit();
                    if (!this.compressorManager.isAvailable(compressionType)) {
                        console.warn(`${compressionType} compressor not available, returning uncompressed`);
                        return { data: prgData, compressed: false };
                    }

                    const uncompressedStart = this.builder.lowestAddress;
                    const executeAddress = visualizerLoadAddress;

                    const result = await this.compressorManager.compress(
                        prgData,
                        compressionType,
                        uncompressedStart,
                        executeAddress
                    );

                    return { data: result.data, compressed: true };

                } catch (error) {
                    console.error(`${compressionType} compression failed:`, error);
                    return { data: prgData, compressed: false };
                }
            }

            return { data: prgData, compressed: false };

        } catch (error) {
            console.error('Error creating PRG:', error);
            throw error;
        }
    }
}

window.PRGBuilder = PRGBuilder;
window.SIDquakePRGExporter = SIDquakePRGExporter;