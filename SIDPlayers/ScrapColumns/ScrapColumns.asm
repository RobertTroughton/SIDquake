// =============================================================================
//                              SCRAP COLUMNS
//                   3D Column Spectrum Visualizer by Scrap
//                          Adapted for SIDquake
// =============================================================================
//
// 20 multicolor 3D columns across the full screen width.
// Each column is 2 characters wide, 24 rows tall (3 sections of 8 rows).
// Each section shows one SID voice independently (V0=upper, V1=lower, V2=lowest).
//
// Memory Map (VIC Bank relative):
//   +$3800-$3FFF : CharSet (MC mode)
//   +$3000-$33FF : Screen 0
//   +$3400-$37FF : Screen 1 (double buffer)
//   +$2000-$22FF : 1x1 text font (RAM, only when a custom font is injected)
//   +$2400-$27FF : Scroll text (injected; the song line scrolls it after ~3s)
//   +$2800-$29FF : Top-border text sprites (8 x 64 bytes: Artist + Song Name)
//   +$2C00-$2C77 : Upper char lookup table
//   +$2C80-$2CF7 : Lower char lookup table
//   +$2D00-$2D77 : Lowest char lookup table
//   +$2D80-$2DBF : Conversion table
//   +$2DC0-$2DFF : Column height buffers (3 x 20 bytes)
//
// The top border shows the Artist name (top line) and Song name (bottom line)
// rendered from a 1x1 font into 8 non-expanded sprites (3 chars each = 24 cols).
// After ~3 seconds the Song line turns into a sprite scroller (bottom 8 rows).

.var LOAD_ADDRESS                   = cmdLineVars.get("loadAddress").asNumber()
.var CODE_ADDRESS                   = cmdLineVars.get("sysAddress").asNumber()
.var DATA_ADDRESS                   = cmdLineVars.get("dataAddress").asNumber()

// =============================================================================
// CONFIGURATION CONSTANTS
// =============================================================================

.const NUM_BARS_PER_VOICE            = 20
.const NUM_COLUMNS                  = 20

.const TOP_SPECTRUM_HEIGHT          = 8
.const BOTTOM_SPECTRUM_HEIGHT       = 0

// Scrap's char tables require buffer values in range $10-$3F (48 values per section)
// Each voice section has 48 height levels (0-47), mapped to $10-$3F
.const MAX_BAR_HEIGHT               = 47

// Match RaistlinBars' rise speed: it climbs ~1.3/8 of full height per frame
// (rate = TOP_SPECTRUM_HEIGHT*1.3 over a TOP_SPECTRUM_HEIGHT*8 scale). Scaled to
// this visualizer's MAX_BAR_HEIGHT so a bar takes a similar time to shoot up.
.const BAR_INCREASE_RATE            = ceil(MAX_BAR_HEIGHT * 1.3 / 8)
.const BAR_DECREASE_RATE            = ceil(MAX_BAR_HEIGHT / 24.0)

// =============================================================================
// DATA BLOCK
// =============================================================================

* = DATA_ADDRESS "Data Block"
    .fill $0D, $00                      // Reserved bytes 0-12
borderColor:
    .byte $00                           // Byte 13 ($0D): Border color
backgroundColor:
    .byte $00                           // Byte 14 ($0E): Background color
    .fill $60 - $0F, $00                // Reserved bytes 15-95
colorEffectMode:
    .byte $00                           // Byte 96 ($60): Color effect mode (unused but kept for compatibility)
lineGradientColors:
    .fill TOP_SPECTRUM_HEIGHT + BOTTOM_SPECTRUM_HEIGHT, $0b  // Bytes 97+: Line gradient colors
    .fill $71 - $61 - (TOP_SPECTRUM_HEIGHT + BOTTOM_SPECTRUM_HEIGHT), $00   // pad to $71
fontMode:
    .byte $00                           // $71: 0 = text from C64 ROM font, 1 = injected RAM font
songNameColor:
    .byte $01                           // $72: Song name text colour (also the scroller colour)
artistNameColor:
    .byte $0f                           // $73: Artist name text colour
    .fill $100 - $74, $00

* = CODE_ADDRESS "Main Code"

    jmp Initialize

.var VIC_BANK                       = floor(LOAD_ADDRESS / $4000)
.var VIC_BANK_ADDRESS               = VIC_BANK * $4000
.var SPRITES_ADDRESS			    = VIC_BANK_ADDRESS + $2800

// =============================================================================
// CONFIGURATION CONSTANTS (continued)
// =============================================================================

.const SCREEN0_BANK                 = 12    //; +$3000
.const SCREEN1_BANK                 = 13    //; +$3400
.const CHARSET_BANK                 = 7     //; +$3800

.const SCREEN0_ADDRESS              = VIC_BANK_ADDRESS + (SCREEN0_BANK * $400)
.const SCREEN1_ADDRESS              = VIC_BANK_ADDRESS + (SCREEN1_BANK * $400)
.const CHARSET_ADDRESS              = VIC_BANK_ADDRESS + (CHARSET_BANK * $800)

.const D018_VALUE_0                 = (SCREEN0_BANK * 16) + (CHARSET_BANK * 2)
.const D018_VALUE_1                 = (SCREEN1_BANK * 16) + (CHARSET_BANK * 2)

// Char lookup tables placed after code (page-aligned for indexed addressing)
.const UPPER_TABLE_ADDRESS          = VIC_BANK_ADDRESS + $2C00
.const LOWER_TABLE_ADDRESS          = VIC_BANK_ADDRESS + $2C80
.const LOWEST_TABLE_ADDRESS         = VIC_BANK_ADDRESS + $2D00
.const CONV_TABLE_ADDRESS           = VIC_BANK_ADDRESS + $2D80
.const COLUMN_BUFFERS_ADDRESS       = VIC_BANK_ADDRESS + $2DC0

// Sprite data - 64-byte aligned within VIC bank (placed before screen)
.const SPRITE_DATA_ADDRESS          = VIC_BANK_ADDRESS + $2FC0
.const SPRITE_POINTER               = ($2FC0 / $40)

// ---- Top-border text sprites (Artist + Song), font + scroller ---------------
// 8 non-expanded sprites (24px each = 192px), 3 chars per sprite = 24 columns.
// The 21 sprite rows hold: Artist glyph (rows 0-7), 5px gap (8-12), Song glyph
// (rows 13-20). Both lines share songNameColor. SPRITES_ADDRESS (= VIC+$2800)
// is the 8x64 sprite data, pointer base $A0.
.const NUM_TEXT_SPRITES             = 8
.const TEXT_COLS                    = NUM_TEXT_SPRITES * 3   // 24
.const TEXT_SPRITE_PTR              = ($2800 / $40)          // $A0
.const TEXT_SPRITE_Y                = 29                     // top border, just above the screen
.const SONG_ROW_OFFSET              = 13 * 3                 // byte offset of the Song line (row 13)
.const SCROLLER_START_FRAME         = 150                    // ~3s at 50 Hz before the song line scrolls

// 1x1 text font. ROM by default (read via the $01 banking trick); a custom font
// is injected into RAM at RAM_CHARSET_ADDRESS (3 pages: codes 0-31/32-63/64-95).
.const RAM_CHARSET_ADDRESS          = VIC_BANK_ADDRESS + $2000
.const RAM_CHARSET_BASE_HI          = >RAM_CHARSET_ADDRESS

// Scroll text (injected by the exporter, null-terminated).
.const SCROLLTEXT_ADDR              = VIC_BANK_ADDRESS + $2400

// Color table (for compatibility with prg-builder, though not actively used for dynamic colors)
.const COLOR_TABLE_ADDRESS          = VIC_BANK_ADDRESS + $2E00
.const COLOR_TABLE_SIZE             = MAX_BAR_HEIGHT + 9

// =============================================================================
// INCLUDES
// =============================================================================

#define INCLUDE_SPACE_FASTFORWARD
#define INCLUDE_PLUS_MINUS_SONGCHANGE
#define INCLUDE_09ALPHA_SONGCHANGE
#define INCLUDE_F1_SHOWRASTERTIMINGBAR
#define INCLUDE_MUSIC_ANALYSIS

// Raster line for music call 0. This is also the IRQ that opens the lower
// border (MusicFrameHandler flips to 24-row mode), so it must fire a couple of
// lines EARLY - at 248, not 250 - to switch RSEL=0 before the VIC reaches the
// 25-row bottom-border compare; at 250 the IRQ latency lands too late and the
// top/bottom borders don't open. The remaining calls are CIA-timer driven and
// may be interrupted by the border-trick IRQs (see INC/multicallirq.asm).
.const MUSIC_SYNC_LINE = 248

.import source "../INC/common.asm"
.import source "../INC/keyboard.asm"
.import source "../INC/musicplayback.asm"
.import source "../INC/multicallirq.asm"
.import source "../INC/stablerastersetup.asm"
.import source "../INC/spectrometerpervoice.asm"
.import source "../INC/freqtable20.asm"
.import source "../INC/linkedwitheffect.asm"

// =============================================================================
// DATA
// =============================================================================

visualizationUpdateFlag:    .byte $00
frameCounter:               .byte $00
frame256Counter:            .byte $00
currentScreenBuffer:        .byte $00
scrollActive:               .byte $00      // 0 = static song line, 1 = scroller running

D018Values:                 .byte D018_VALUE_0, D018_VALUE_1

// =============================================================================
// INITIALIZATION
// =============================================================================

Initialize:
    sei

    lda #$35
    sta $01

    jsr RunLinkedWithEffect

    jsr InitKeyboard

    jsr SetupStableRaster
    lda #(63 - VIC_BANK)
    sta $dd00
    lda #VIC_BANK
    sta $dd02
    jsr NMIFix

    jsr InitializeVIC
    jsr ClearScreen
    jsr InitializeColors
    jsr DisplaySongInfo
    jsr DisplayRow25

    jsr RenderTextSprites       // draw Artist (top) + Song (bottom) into the 8 sprites

    jsr InitializeBarArrays

    // Clear column buffers to $10 (minimum visible, valid range $10-$3F)
    lda #$10
    ldx #59
!clrBuf:
    sta columnBuffer, x
    dex
    bpl !clrBuf-

    jsr SetupMusic

    jsr InitMultiCallIRQ
    StartRasterEvents(MUSIC_SYNC_LINE, MusicFrameHandler)

    jsr VSync

    lda #$1b
    sta $d011

    cli

MainLoop:
    jsr CheckKeyboard

    lda FastForwardActive
    beq !noFF+

    // Fast-forward mode: call SIDPlay multiple times from main loop.
    // The IRQ framework skips its own play calls while this is active.
!ffFrameLoop:
    lda NumCallsPerFrame
    sta FFCallCounter

!ffCallLoop:
    jsr SIDPlay
    inc $d020
    dec FFCallCounter
    bne !ffCallLoop-

    jsr CheckMusicLoop          // forced song loop tracks fast-forwarded frames too
    jsr CheckSpaceKey
    lda FastForwardActive
    bne !ffFrameLoop-

    lda borderColor
    sta $d020
!noFF:

    lda visualizationUpdateFlag
    beq MainLoop

    jsr ApplySmoothingAllVoices
    jsr ConvertToColumns

    // Render to the *off-screen* buffer (the one not currently displayed),
    // then flip - the frame IRQ picks up the new buffer via D018Values.
    lda currentScreenBuffer
    beq !renderScreen1+
    jsr RenderColumnsToScreen0
    jmp !rendered+
!renderScreen1:
    jsr RenderColumnsToScreen1
!rendered:

    lda currentScreenBuffer
    eor #$01
    sta currentScreenBuffer

    lda #$00
    sta visualizationUpdateFlag

    jmp MainLoop

// =============================================================================
// VIC INITIALIZATION
// =============================================================================

InitializeVIC:
    // Set multicolor text mode
    lda #$d8                            // MC on ($d0 | $08)
    sta $d016
    lda #D018_VALUE_0
    sta $d018

    // Load colors from data block
    lda borderColor
    sta $d020

    // Screen background must be $0b for border/sprite continuity
    lda #$0b
    sta $d021

    // Multicolor shared colors (charset bit pairs: 01=$d022, 10=$d023)
    lda #$0c
    sta $d022
    lda #$00
    sta $d023
    sta $d01b                           // Sprites in front of background
    sta $d026                           // Sprite MC color 1 = black
    lda #$0c
    sta $d025                           // Sprite MC color 0 = medium grey

    jsr SetBottomSprites

    lda #$03
    sta VIC_BANK_ADDRESS + $3FFF

    rts

// =============================================================================
// INTERRUPT HANDLERS (see INC/multicallirq.asm for the shared scheduler)
// Three raster events per frame: the frame call at MUSIC_SYNC_LINE (opens the
// bottom border), the top-border event at line 0 and the screen event at
// line 50. The border events are "urgent": they may interrupt a music call,
// flip the VIC registers/sprites and return without affecting playback.
// =============================================================================

MusicFrameHandler:
    // Set ghost byte for bottom border area (sprite-like pattern)
    lda #$03
    sta VIC_BANK_ADDRESS + $3FFF

    // Open bottom border: switch to 24-row mode (RSEL=0)
    lda #$13
    sta $d011

    // Display the buffer the main loop finished rendering
    ldy currentScreenBuffer
    lda D018Values, y
    sta $d018

    SetNextRasterEvent(0, TopBorderIRQ)
    jmp MusicFrameCall

// The analysis play must stay inside the CIA-masked music section: it runs a
// throwaway SIDPlay under Backup/RestoreSIDMemory, and a nested real call in
// that window would have its state changes wiped by the restore.
MusicCall_Frame:
    jmp PlayMusicWithAnalysis

MusicCall_Other:
    jmp JustPlayMusic

FrameCall:
    inc visualizationUpdateFlag

    inc frameCounter
    bne !skip+
    inc frame256Counter
!skip:

    jsr UpdateScroller
    jmp UpdateBarsAllVoices

// =============================================================================
// TOP BORDER INTERRUPT HANDLER (rasterline 0)
// Sets ghost byte to $FF for fully black top border area
// =============================================================================

TopBorderIRQ:
    // Set ghost byte for top border area (fully black)
    lda #$ff
    sta VIC_BANK_ADDRESS + $3FFF

    // Restore 25-row mode (RSEL=1) so border trick works next frame
    lda #$1b
    sta $d011

    jsr SetTopSprites

    SetNextRasterEvent(50, ScreenIRQ)
    jmp ExitIRQ

ScreenIRQ:
    jsr SetBottomSprites

    // Roll the song-line scroller here, NOT in the music section. The text
    // sprites are read by the VIC at lines 29-49; by line 50 they are done and
    // SetBottomSprites has just re-pointed the sprites at the bottom filler, so
    // the text-sprite data is free to rewrite for the rest of the frame. Doing
    // the ROL in the CIA-timed music call chased the beam and glitched.
    lda scrollActive
    cmp #1
    bne !noScroll+
    jsr ScrollSongLine
!noScroll:

    SetNextRasterEvent(MUSIC_SYNC_LINE, MusicFrameHandler)
    jmp ExitIRQ

// Top-of-frame config: the 8 text sprites showing Artist + Song, non-expanded,
// centred (192px band) in the top border at Y=29, all in songNameColor. The
// same 8 hardware sprites are re-purposed at the bottom by SetBottomSprites.
SetTopSprites:

    lda songNameColor
    ldy #TEXT_SPRITE_Y
    .for (var i = 0; i < 8; i++)
    {
        ldx #<(88 + (i * 24))           // centred 192px band: X = 88,112,..,256
        stx $d000 + (i * 2)
        sty $d001 + (i * 2)
        sta $d027 + i
    }
    lda #$80                            // only sprite 7 (X=256) crosses the 256 line
    sta $d010

    .for (var i = 0; i < 8; i++)
    {
        lda #TEXT_SPRITE_PTR + i
        sta SCREEN0_ADDRESS + $3F8 + i  // Both buffers: VIC reads pointers
        sta SCREEN1_ADDRESS + $3F8 + i  // from whichever screen is active
    }

    lda #$ff
    sta $d015                           // all 8 sprites on
    lda #$00
    sta $d01d                           // NOT X-expanded (small sprites)
    sta $d017                           // NOT Y-expanded
    sta $d01c                           // hires

    rts


// Bottom-of-frame config: park all 8 sprites in the bottom border, border-
// coloured (invisible) so the text sprites don't re-appear lower down.
SetBottomSprites:

    lda #$ff
    sta $d015                           // all 8 sprites on
    sta $d01d                           // X-expand
    sta $d017                           // Y-expand
    sta $d01c                           // multicolour (doesn't matter - invisible)

    lda borderColor
    ldx #7
!col:
    sta $d027, x                        // all 8 sprite colours = border
    dex
    bpl !col-

    lda #$fa                            // Y = 250 (bottom border)
    .for (var i = 0; i < 8; i++)
    {
        sta $d001 + (i * 2)
    }

    lda #SPRITE_POINTER
    .for (var i = 0; i < 8; i++)
    {
        ldx #<(24 + (i * 48))           // same 48px-expanded spread as the original 7,
        stx $d000 + (i * 2)             // plus sprite 7 continuing off the right edge
        sta SCREEN0_ADDRESS + $3F8 + i  // Both buffers: VIC reads pointers
        sta SCREEN1_ADDRESS + $3F8 + i  // from whichever screen is active
    }

    lda #$e0                            // sprites 5,6,7 (X=264,312,360) cross the 256 line
    sta $d010                           // X MSB
    rts


// =============================================================================
// TOP-BORDER TEXT (Artist + Song) + SCROLLER
//
// The 8 sprites hold a 24-column (8x3) text band: Artist glyph in rows 0-7,
// a 5px gap, Song glyph in rows 13-20 (SONG_ROW_OFFSET). Glyphs come from a
// 1x1 font - the C64 ROM font by default (banked in via $01 for the reads) or
// an injected RAM font at RAM_CHARSET_ADDRESS. After ~3s the Song line becomes
// a bit-ROL scroller: an 8-byte off-screen feed buffer (scrollFeed, one per
// row) is ROLled into the rightmost sprite byte one pixel-column per frame, so
// characters roll in smoothly with no popping; a new char loads every 8 frames.
// =============================================================================

// The font is always an injected RAM charset (RAM_CHARSET_ADDRESS) - both the
// glyph readers just index into it. Nothing touches $01: the charset and the
// sprite data are both plain RAM, so banking the ROM in (and out) is neither
// needed nor safe (an IRQ arriving with I/O banked out hangs the machine).

// Render Artist (top) + Song (bottom) into the 8 sprite blocks, 3 chars each.
// Each name is reformatted from the exporter's 32-wide centred string into our
// 24 columns (FormatName24): centred if it fits, else the first 21 chars + "...".
RenderTextSprites:
    lda #0                              // clear the 512 bytes of sprite data
    tax
!clr:
    sta SPRITES_ADDRESS, x
    sta SPRITES_ADDRESS + $100, x
    inx
    bne !clr-

    lda #<ArtistName                    // Artist -> nameBuf24 -> top line (offset 0)
    ldy #>ArtistName
    jsr FormatName24
    lda #$00
    sta RTS_LineOff + 1
    jsr RenderLine

    lda #<SongName                      // Song -> nameBuf24 -> bottom line (offset 39)
    ldy #>SongName
    jsr FormatName24
    lda #SONG_ROW_OFFSET
    sta RTS_LineOff + 1
    jsr RenderLine
    rts

// Render nameBuf24 across the 24 columns at the current RTS_LineOff line.
RenderLine:
    ldx #0
!rl:
    lda nameBuf24, x
    jsr RTS_RenderChar
    inx
    cpx #TEXT_COLS
    bne !rl-
    rts

// Reformat the 32-char centred name at (A=lo, Y=hi) into the 24-char nameBuf24:
// strip the exporter's centring padding, then centre in 24 if it fits, else the
// first 21 chars followed by "...".
FormatName24:
    sta FN_copySrc + 1
    sty FN_copySrc + 2
    ldy #31                             // copy the 32-char source into workBuf
!copy:
FN_copySrc:
    lda $ffff, y
    sta workBuf, y
    dey
    bpl !copy-

    ldx #23                             // blank the 24-char output
    lda #$20
!blank:
    sta nameBuf24, x
    dex
    bpl !blank-

    ldx #0                              // find the first non-space
!fs:
    lda workBuf, x
    cmp #$20
    bne !gotStart+
    inx
    cpx #32
    bne !fs-
    rts                                 // all spaces: leave the output blank
!gotStart:
    stx fnStart

    ldy #31                             // find the last non-space
!fe:
    lda workBuf, y
    cmp #$20
    bne !gotEnd+
    dey
    bpl !fe-
!gotEnd:
    sty fnEnd
    tya                                 // A = len-1 = end - start
    sec
    sbc fnStart
    cmp #24                             // len > 24 chars? -> crop
    bcs !crop+

    sta fnTmp                           // centred: pad = (23 - (len-1)) / 2
    lda #23
    sec
    sbc fnTmp
    lsr
    tax                                 // X = output index (pad)
    ldy fnStart
!copyC:
    lda workBuf, y
    sta nameBuf24, x
    inx
    iny
    cpy fnEnd
    bcc !copyC-
    beq !copyC-                         // include the last char (y == end)
    rts

!crop:                                  // first 21 chars, then "..."
    ldy fnStart
    ldx #0
!copyD:
    lda workBuf, y
    sta nameBuf24, x
    iny
    inx
    cpx #21
    bne !copyD-
    lda #$2e                            // '.'
!dots:
    sta nameBuf24, x
    inx
    cpx #24
    bne !dots-
    rts

workBuf:    .fill 32, $20
nameBuf24:  .fill 24, $20
fnStart:    .byte $00
fnEnd:      .byte $00
fnTmp:      .byte $00

// Draw one glyph column. X = text column 0..23, A = char (screen code),
// RTS_LineOff+1 = sprite-byte line offset (0 = Artist, 39 = Song).
RTS_RenderChar:
    pha                                 // glyph src hi = (char>>5) | charset base
    lsr
    lsr
    lsr
    lsr
    lsr
RTS_CharsetOra:
    ora #RAM_CHARSET_BASE_HI
    sta RTS_GlyphSrc + 2
    pla                                 // glyph src lo = (char & 31) * 8
    and #$1f
    asl
    asl
    asl
    sta RTS_GlyphSrc + 1

    lda SprColLo, x                     // dest = sprite col base + line offset
    clc
RTS_LineOff:
    adc #$00
    sta RTS_Dst + 1
    lda SprColHi, x
    adc #$00
    sta RTS_Dst + 2

    ldy #0                              // copy 8 glyph rows, dest steps 3 bytes/row
!row:
RTS_GlyphSrc:
    lda $abcd, y
RTS_Dst:
    sta $abcd
    lda RTS_Dst + 1
    clc
    adc #3
    sta RTS_Dst + 1
    bcc !nc+
    inc RTS_Dst + 2
!nc:
    iny
    cpy #8
    bne !row-
    rts

// Per-frame (from the music section): just the timer/activation logic - hold the
// static text for ~3s, then arm the scroller. The actual pixel ROL runs in
// ScreenIRQ (beam-safe), not here. scrollActive: 0 = waiting, 1 = scrolling,
// $ff = no scroll text (static Artist/Song forever).
UpdateScroller:
    lda scrollActive
    beq !waiting+
    rts                                 // 1 = running (ROL is in ScreenIRQ) / $ff = disabled
!waiting:
    lda frame256Counter                 // ~3s elapsed? (>=256 frames, or >=150 in the first 256)
    bne !elapsed+
    lda frameCounter
    cmp #SCROLLER_START_FRAME
    bcc !ret+
!elapsed:
    lda SCROLLTEXT_ADDR                 // any scroll text? (empty = null first byte)
    bne !start+
    lda #$ff                            // none: keep the static song name for good
    sta scrollActive
    rts
!start:
    lda #1
    sta scrollActive
    lda #7
    sta scrollStep
    jsr ScrollFetchNextChar             // prime the feed with the first char
!ret:
    rts

// Roll the Song line (bottom 8 rows) left one pixel; feed the next char column
// in. Called from ScreenIRQ (line 50) so the beam is clear of the text sprites.
ScrollSongLine:
    .for (var r = 0; r < 8; r++)
    {
        clc                             // 0 into the feed byte's LSB
        rol scrollFeed + r              // feed bit7 -> carry -> rightmost sprite byte
        .for (var i = 23; i >= 0; i--)
        {
            rol SPRITES_ADDRESS + (floor(i / 3) * 64) + SONG_ROW_OFFSET + (r * 3) + mod(i, 3)
        }
    }
    dec scrollStep
    bpl !done+
    lda #7
    sta scrollStep
    jsr ScrollFetchNextChar             // 8 columns done - load the next char
!done:
    rts

// Load the next scroll-text char's 8 glyph rows into the feed buffer.
ScrollFetchNextChar:
ScrollRead:
    lda SCROLLTEXT_ADDR
    bne !ok+
    lda #<SCROLLTEXT_ADDR               // null terminator -> rewind to the start
    sta ScrollRead + 1
    lda #>SCROLLTEXT_ADDR
    sta ScrollRead + 2
    jmp ScrollFetchNextChar
!ok:
    pha
    lsr
    lsr
    lsr
    lsr
    lsr
ScrollCharsetOra:
    ora #RAM_CHARSET_BASE_HI
    sta ScrollGlyphSrc + 2
    pla
    and #$1f
    asl
    asl
    asl
    sta ScrollGlyphSrc + 1
    ldy #7
!g:
ScrollGlyphSrc:
    lda $abcd, y
    sta scrollFeed, y
    dey
    bpl !g-
    inc ScrollRead + 1                  // advance the scroll-text pointer
    bne !nc+
    inc ScrollRead + 2
!nc:
    rts

// Runtime scroller state + the per-column sprite-byte address of column 0's row 0.
scrollFeed:   .fill 8, $00
scrollStep:   .byte $00
SprColLo:     .fill 24, <(SPRITES_ADDRESS + (floor(i / 3) * 64) + mod(i, 3))
SprColHi:     .fill 24, >(SPRITES_ADDRESS + (floor(i / 3) * 64) + mod(i, 3))


// =============================================================================
// CONVERT SMOOTHED HEIGHTS TO COLUMN BUFFERS
// Each voice's smoothed heights (0-47) are mapped to $10-$3F
// Voice 0 → upper section, Voice 1 → lower section, Voice 2 → lowest section
// =============================================================================

ConvertToColumns:
    ldx #NUM_COLUMNS - 1
!loop:
    // Voice 0 → upper section (rows 0-7)
    lda smoothedHeightsV0, x
    clc
    adc #$10
    sta columnBuffer, x

    // Voice 1 → lower section (rows 8-15)
    lda smoothedHeightsV1, x
    clc
    adc #$10
    sta columnBuffer + NUM_COLUMNS, x

    // Voice 2 → lowest section (rows 16-23)
    lda smoothedHeightsV2, x
    clc
    adc #$10
    sta columnBuffer + (NUM_COLUMNS * 2), x

    dex
    bpl !loop-
    rts

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

ClearScreen:
    ldx #$00
    lda #$fc
!loop:
    sta SCREEN0_ADDRESS + $000, x
    sta SCREEN0_ADDRESS + $100, x
    sta SCREEN0_ADDRESS + $200, x
    sta SCREEN0_ADDRESS + $2e8, x
    sta SCREEN1_ADDRESS + $000, x
    sta SCREEN1_ADDRESS + $100, x
    sta SCREEN1_ADDRESS + $200, x
    sta SCREEN1_ADDRESS + $2e8, x
    inx
    bne !loop-
    rts

DisplaySongInfo:

    rts

InitializeColors:

    ldy #$00
!colLoop:
    lda #$0b
    sta $d800, y
    sta $d800 + 64, y
    lda #$0f
    sta $d800 + 320, y
    sta $d800 + 384, y
    lda #$09
    sta $d800 + 640, y
    sta $d800 + 704, y
    iny
    bne !colLoop-

    // Row 24 (colour RAM $DBC0-$DBE7). The three voice bands above cover only
    // rows 0-23; row 24 (DisplayRow25's decorative $0e/$0f line) was left
    // uninitialised. In MC text mode a colour-RAM value with bit 3 CLEAR renders
    // the cell in hires, not multicolour, so the row's $55/$02 chars come out
    // striped instead of solid - and the SIDquake intro leaves its watermark
    // cells (row 24, cols 30-38) = $00 (bit 3 clear), which corrupted them. Set the whole row
    // to $09 (bit 3 set -> MC; matches the lowest band) so it renders correctly
    // regardless of what the intro or the loader left behind.
    ldy #39
    lda #$09
!row24:
    sta $d800 + 960, y
    dey
    bpl !row24-

    rts

DisplayRow25:
    // Row 25 (screen + 960): alternating $0e/$0f chars (like original)
    ldy #0
!row25:
    lda #$0e
    sta SCREEN0_ADDRESS + 960, y
    sta SCREEN1_ADDRESS + 960, y
    iny
    lda #$0f
    sta SCREEN0_ADDRESS + 960, y
    sta SCREEN1_ADDRESS + 960, y
    iny
    cpy #40
    bne !row25-
    rts

SetupMusic:
    ldy #24
    lda #$00
!loop:
    sta $d400, y
    dey
    bpl !loop-

    lda SongNumber
    tax
    tay
    jmp SIDInit

// =============================================================================
// COLUMNS EFFECT - rendering logic by Scrap
// Reads from columnBuffer (3 x 20 bytes) via convtable
// Writes character codes to screen RAM
//
// Restructured from one fully unrolled single-screen routine into a
// column-looped (rows still unrolled) section macro, instantiated once per
// screen buffer - this is what makes double buffering affordable: two full
// renderers cost ~0.8KB instead of ~12KB. Same chars, same carry trick:
// the second char of each 2-wide column is first char + 1.
// =============================================================================

// Render one 8-row section of 20 two-char-wide columns.
//   bufOffset  : offset into columnBuffer for this section's heights
//   charTable  : upper/lower/lowest char lookup table
//   screenBase : screen address of this section's top-left corner
.macro RenderColumnSection(bufOffset, charTable, screenBase) {
    ldy #NUM_COLUMNS - 1
!colLoop:
    lda columnBuffer + bufOffset, y     // height ($10-$3F)
    tax
    lda convtable, x                    // offset into the char table
    tax
    tya
    asl                                 // Y = col * 2 (screen column)
    tay
    clc
    .for (var row = 0; row < 8; row++) {
        lda charTable + row, x
        sta screenBase + (row * 40), y
        adc #1
        sta screenBase + (row * 40) + 1, y
        .if (row < 7) { clc }
    }
    tya
    lsr                                 // back to column index
    tay
    dey
    bpl !colLoop-
    rts
}

RenderColumnsToScreen0:
    jsr !upper+
    jsr !lower+
    jmp !lowest+
!upper:  RenderColumnSection(0, upper, SCREEN0_ADDRESS)
!lower:  RenderColumnSection(NUM_COLUMNS, lower, SCREEN0_ADDRESS + (8 * 40))
!lowest: RenderColumnSection(NUM_COLUMNS * 2, lowest, SCREEN0_ADDRESS + (16 * 40))

RenderColumnsToScreen1:
    jsr !upper+
    jsr !lower+
    jmp !lowest+
!upper:  RenderColumnSection(0, upper, SCREEN1_ADDRESS)
!lower:  RenderColumnSection(NUM_COLUMNS, lower, SCREEN1_ADDRESS + (8 * 40))
!lowest: RenderColumnSection(NUM_COLUMNS * 2, lowest, SCREEN1_ADDRESS + (16 * 40))


// =============================================================================
// CHARACTER LOOKUP TABLES (from Scrap's original)
// =============================================================================

// Upper section: $fc = empty row, character codes for filled rows
// Each "height level" is 15 bytes: 8 interleaved height entries + 7 body chars
// Indexed by convtable[height] to get starting offset within table

* = UPPER_TABLE_ADDRESS "Upper Char Table"
upper:
// Height 7 (barely visible - only last row)
c07: .byte $fc
c0f: .byte $fc
c17: .byte $fc
c1f: .byte $fc
c27: .byte $fc
c2f: .byte $fc
c37: .byte $fc
c3f: .byte $00
     .byte $02, $04, $06, $06, $06, $06, $06
// Height 6
c06: .byte $fc
c0e: .byte $fc
c16: .byte $fc
c1e: .byte $fc
c26: .byte $fc
c2e: .byte $fc
c36: .byte $fc
c3e: .byte $10
     .byte $12, $14, $16, $16, $16, $16, $16
// Height 5
c05: .byte $fc
c0d: .byte $fc
c15: .byte $fc
c1d: .byte $fc
c25: .byte $fc
c2d: .byte $fc
c35: .byte $fc
c3d: .byte $20
     .byte $22, $24, $26, $26, $26, $26, $26
// Height 4
c04: .byte $fc
c0c: .byte $fc
c14: .byte $fc
c1c: .byte $fc
c24: .byte $fc
c2c: .byte $fc
c34: .byte $fc
c3c: .byte $30
     .byte $32, $34, $36, $36, $36, $36, $36
// Height 3
c03: .byte $fc
c0b: .byte $fc
c13: .byte $fc
c1b: .byte $fc
c23: .byte $fc
c2b: .byte $fc
c33: .byte $fc
c3b: .byte $40
     .byte $42, $44, $46, $46, $46, $46, $46
// Height 2
c02: .byte $fc
c0a: .byte $fc
c12: .byte $fc
c1a: .byte $fc
c22: .byte $fc
c2a: .byte $fc
c32: .byte $fc
c3a: .byte $50
     .byte $52, $54, $56, $56, $56, $56, $56
// Height 1
c01: .byte $fc
c09: .byte $fc
c11: .byte $fc
c19: .byte $fc
c21: .byte $fc
c29: .byte $fc
c31: .byte $fc
c39: .byte $60
     .byte $62, $64, $66, $66, $66, $66, $66
// Height 0 (tallest - all 8 rows visible)
c00: .byte $fc
c08: .byte $fc
c10: .byte $fc
c18: .byte $fc
c20: .byte $fc
c28: .byte $fc
c30: .byte $fc
c38: .byte $70
     .byte $72, $74, $76, $76, $76, $76, $76

// Lower section char table
* = LOWER_TABLE_ADDRESS "Lower Char Table"
lower:
d07: .byte $06
d0f: .byte $06
d17: .byte $06
d1f: .byte $06
d27: .byte $06
d2f: .byte $06
d37: .byte $06
d3f: .byte $80
     .byte $82, $84, $86, $86, $86, $86, $86
d06: .byte $06
d0e: .byte $06
d16: .byte $06
d1e: .byte $06
d26: .byte $06
d2e: .byte $06
d36: .byte $06
d3e: .byte $90
     .byte $92, $94, $96, $96, $96, $96, $96
d05: .byte $06
d0d: .byte $06
d15: .byte $06
d1d: .byte $06
d25: .byte $06
d2d: .byte $06
d35: .byte $06
d3d: .byte $a0
     .byte $a2, $a4, $a6, $a6, $a6, $a6, $a6
d04: .byte $06
d0c: .byte $06
d14: .byte $06
d1c: .byte $06
d24: .byte $06
d2c: .byte $06
d34: .byte $06
d3c: .byte $b0
     .byte $b2, $b4, $b6, $b6, $b6, $b6, $b6
d03: .byte $06
d0b: .byte $06
d13: .byte $06
d1b: .byte $06
d23: .byte $06
d2b: .byte $06
d33: .byte $06
d3b: .byte $c0
     .byte $c2, $c4, $c6, $c6, $c6, $c6, $c6
d02: .byte $06
d0a: .byte $06
d12: .byte $06
d1a: .byte $06
d22: .byte $06
d2a: .byte $06
d32: .byte $06
d3a: .byte $d0
     .byte $d2, $d4, $d6, $d6, $d6, $d6, $d6
d01: .byte $06
d09: .byte $06
d11: .byte $06
d19: .byte $06
d21: .byte $06
d29: .byte $06
d31: .byte $06
d39: .byte $e0
     .byte $e2, $e4, $e6, $e6, $e6, $e6, $e6
d00: .byte $06
d08: .byte $06
d10: .byte $06
d18: .byte $06
d20: .byte $06
d28: .byte $06
d30: .byte $06
d38: .byte $f0
     .byte $f2, $f4, $f6, $f6, $f6, $f6, $f6

// Lowest section char table
* = LOWEST_TABLE_ADDRESS "Lowest Char Table"
lowest:
e07: .byte $86
e0f: .byte $86
e17: .byte $86
e1f: .byte $86
e27: .byte $86
e2f: .byte $86
e37: .byte $86
e3f: .byte $08
     .byte $0a, $0c, $0e, $0e, $0e, $0e, $0e
e06: .byte $86
e0e: .byte $86
e16: .byte $86
e1e: .byte $86
e26: .byte $86
e2e: .byte $86
e36: .byte $86
e3e: .byte $18
     .byte $1a, $1c, $1e, $1e, $1e, $1e, $1e
e05: .byte $86
e0d: .byte $86
e15: .byte $86
e1d: .byte $86
e25: .byte $86
e2d: .byte $86
e35: .byte $86
e3d: .byte $28
     .byte $2a, $2c, $2e, $2e, $2e, $2e, $2e
e04: .byte $86
e0c: .byte $86
e14: .byte $86
e1c: .byte $86
e24: .byte $86
e2c: .byte $86
e34: .byte $86
e3c: .byte $38
     .byte $3a, $3c, $3e, $3e, $3e, $3e, $3e
e03: .byte $86
e0b: .byte $86
e13: .byte $86
e1b: .byte $86
e23: .byte $86
e2b: .byte $86
e33: .byte $86
e3b: .byte $48
     .byte $4a, $4c, $4e, $4e, $4e, $4e, $4e
e02: .byte $86
e0a: .byte $86
e12: .byte $86
e1a: .byte $86
e22: .byte $86
e2a: .byte $86
e32: .byte $86
e3a: .byte $58
     .byte $5a, $5c, $5e, $5e, $5e, $5e, $5e
e01: .byte $86
e09: .byte $86
e11: .byte $86
e19: .byte $86
e21: .byte $86
e29: .byte $86
e31: .byte $86
e39: .byte $68
     .byte $6a, $6c, $6e, $6e, $6e, $6e, $6e
e00: .byte $86
e08: .byte $86
e10: .byte $86
e18: .byte $86
e20: .byte $86
e28: .byte $86
e30: .byte $86
e38: .byte $78
     .byte $7a, $7c, $7e, $7e, $7e, $7e, $7e


// =============================================================================
// CONVERSION TABLE
// Maps height value (0-63) to offset within char lookup tables
// =============================================================================

* = CONV_TABLE_ADDRESS "Conversion Table"
convtable:
.byte <c00,<c01,<c02,<c03,<c04,<c05,<c06,<c07,<c08,<c09,<c0a,<c0b,<c0c,<c0d,<c0e,<c0f
.byte <c10,<c11,<c12,<c13,<c14,<c15,<c16,<c17,<c18,<c19,<c1a,<c1b,<c1c,<c1d,<c1e,<c1f
.byte <c20,<c21,<c22,<c23,<c24,<c25,<c26,<c27,<c28,<c29,<c2a,<c2b,<c2c,<c2d,<c2e,<c2f
.byte <c30,<c31,<c32,<c33,<c34,<c35,<c36,<c37,<c38,<c39,<c3a,<c3b,<c3c,<c3d,<c3e,<c3f


// =============================================================================
// COLUMN HEIGHT BUFFERS (3 x 20 bytes)
// =============================================================================

* = COLUMN_BUFFERS_ADDRESS "Column Buffers"
columnBuffer:
    .fill NUM_COLUMNS, 0                // Upper section heights (0-63)
    .fill NUM_COLUMNS, 0                // Lower section heights (0-63)
    .fill NUM_COLUMNS, 0                // Lowest section heights (0-63)


// =============================================================================
// COLOR TABLE (for prg-builder compatibility)
// =============================================================================

* = COLOR_TABLE_ADDRESS "Color Table"
heightToColor:              .fill COLOR_TABLE_SIZE, $0b


// =============================================================================
// CHARSET DATA (multicolor pre-shifted column characters by Scrap)
// =============================================================================

* = CHARSET_ADDRESS "Font"
.byte $A9,$A7,$9F,$7F,$FF,$FF,$7F,$5F
.byte $AA,$6A,$DA,$F6,$FE,$F6,$D2,$46
.byte $77,$5D,$57,$5D,$57,$55,$57,$55
.byte $12,$42,$12,$42,$02,$42,$02,$02
.byte $57,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $54,$53,$4F,$3F,$FF,$FF,$7F,$5F
.byte $02,$82,$E2,$FA,$FE,$F6,$D2,$46
.byte $77,$5D,$57,$5D,$57,$55,$57,$55
.byte $12,$42,$12,$42,$02,$42,$02,$02
.byte $57,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$A9,$A7,$9F,$7F,$FF,$FF,$7F
.byte $AA,$AA,$6A,$DA,$F6,$FE,$F6,$D2
.byte $5F,$77,$5D,$57,$5D,$57,$55,$57
.byte $46,$12,$42,$12,$42,$02,$42,$02
.byte $55,$57,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$54,$53,$4F,$3F,$FF,$FF,$7F
.byte $02,$02,$82,$E2,$FA,$FE,$F6,$D2
.byte $5F,$77,$5D,$57,$5D,$57,$55,$57
.byte $46,$12,$42,$12,$42,$02,$42,$02
.byte $55,$57,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$A9,$A7,$9F,$7F,$FF,$FF
.byte $AA,$AA,$AA,$6A,$DA,$F6,$FE,$F6
.byte $7F,$5F,$77,$5D,$57,$5D,$57,$55
.byte $D2,$46,$12,$42,$12,$42,$02,$42
.byte $57,$55,$57,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$54,$53,$4F,$3F,$FF,$FF
.byte $02,$02,$02,$82,$E2,$FA,$FE,$F6
.byte $7F,$5F,$77,$5D,$57,$5D,$57,$55
.byte $D2,$46,$12,$42,$12,$42,$02,$42
.byte $57,$55,$57,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$A9,$A7,$9F,$7F,$FF
.byte $AA,$AA,$AA,$AA,$6A,$DA,$F6,$FE
.byte $FF,$7F,$5F,$77,$5D,$57,$5D,$57
.byte $F6,$D2,$46,$12,$42,$12,$42,$02
.byte $55,$57,$55,$57,$55,$55,$55,$55
.byte $42,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$54,$53,$4F,$3F,$FF
.byte $02,$02,$02,$02,$82,$E2,$FA,$FE
.byte $FF,$7F,$5F,$77,$5D,$57,$5D,$57
.byte $F6,$D2,$46,$12,$42,$12,$42,$02
.byte $55,$57,$55,$57,$55,$55,$55,$55
.byte $42,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$AA,$A9,$A7,$9F,$7F
.byte $AA,$AA,$AA,$AA,$AA,$6A,$DA,$F6
.byte $FF,$FF,$7F,$5F,$77,$5D,$57,$5D
.byte $FE,$F6,$D2,$46,$12,$42,$12,$42
.byte $57,$55,$57,$55,$57,$55,$55,$55
.byte $02,$42,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$54,$53,$4F,$3F
.byte $02,$02,$02,$02,$02,$82,$E2,$FA
.byte $FF,$FF,$7F,$5F,$77,$5D,$57,$5D
.byte $FE,$F6,$D2,$46,$12,$42,$12,$42
.byte $57,$55,$57,$55,$57,$55,$55,$55
.byte $02,$42,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$AA,$AA,$A9,$A7,$9F
.byte $AA,$AA,$AA,$AA,$AA,$AA,$6A,$DA
.byte $7F,$FF,$FF,$7F,$5F,$77,$5D,$57
.byte $F6,$FE,$F6,$D2,$46,$12,$42,$12
.byte $5D,$57,$55,$57,$55,$57,$55,$55
.byte $42,$02,$42,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$54,$53,$4F
.byte $02,$02,$02,$02,$02,$02,$82,$E2
.byte $3F,$FF,$FF,$7F,$5F,$77,$5D,$57
.byte $FA,$FE,$F6,$D2,$46,$12,$42,$12
.byte $5D,$57,$55,$57,$55,$57,$55,$55
.byte $42,$02,$42,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$AA,$AA,$AA,$A9,$A7
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$6A
.byte $9F,$7F,$FF,$FF,$7F,$5F,$77,$5D
.byte $DA,$F6,$FE,$F6,$D2,$46,$12,$42
.byte $57,$5D,$57,$55,$57,$55,$57,$55
.byte $12,$42,$02,$42,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$54,$53
.byte $02,$02,$02,$02,$02,$02,$02,$82
.byte $4F,$3F,$FF,$FF,$7F,$5F,$77,$5D
.byte $E2,$FA,$FE,$F6,$D2,$46,$12,$42
.byte $57,$5D,$57,$55,$57,$55,$57,$55
.byte $12,$42,$02,$42,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$A9
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $A7,$9F,$7F,$FF,$FF,$7F,$5F,$77
.byte $6A,$DA,$F6,$FE,$F6,$D2,$46,$12
.byte $5D,$57,$5D,$57,$55,$57,$55,$57
.byte $42,$12,$42,$02,$42,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$54
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $53,$4F,$3F,$FF,$FF,$7F,$5F,$77
.byte $82,$E2,$FA,$FE,$F6,$D2,$46,$12
.byte $5D,$57,$5D,$57,$55,$57,$55,$57
.byte $42,$12,$42,$02,$42,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $54,$53,$4F,$3F,$FF,$FF,$7F,$5F
.byte $02,$82,$E2,$FA,$FE,$F6,$D2,$46
.byte $77,$5D,$57,$5D,$57,$55,$57,$55
.byte $12,$42,$12,$42,$02,$42,$02,$02
.byte $57,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $55,$54,$53,$4F,$3F,$FF,$FF,$7F
.byte $02,$02,$82,$E2,$FA,$FE,$F6,$D2
.byte $5F,$77,$5D,$57,$5D,$57,$55,$57
.byte $46,$12,$42,$12,$42,$02,$42,$02
.byte $55,$57,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $55,$55,$54,$53,$4F,$3F,$FF,$FF
.byte $02,$02,$02,$82,$E2,$FA,$FE,$F6
.byte $7F,$5F,$77,$5D,$57,$5D,$57,$55
.byte $D2,$46,$12,$42,$12,$42,$02,$42
.byte $57,$55,$57,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $55,$55,$55,$54,$53,$4F,$3F,$FF
.byte $02,$02,$02,$02,$82,$E2,$FA,$FE
.byte $FF,$7F,$5F,$77,$5D,$57,$5D,$57
.byte $F6,$D2,$46,$12,$42,$12,$42,$02
.byte $55,$57,$55,$57,$55,$55,$55,$55
.byte $42,$02,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $55,$55,$55,$55,$54,$53,$4F,$3F
.byte $02,$02,$02,$02,$02,$82,$E2,$FA
.byte $FF,$FF,$7F,$5F,$77,$5D,$57,$5D
.byte $FE,$F6,$D2,$46,$12,$42,$12,$42
.byte $57,$55,$57,$55,$57,$55,$55,$55
.byte $02,$42,$02,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $55,$55,$55,$55,$55,$54,$53,$4F
.byte $02,$02,$02,$02,$02,$02,$82,$E2
.byte $3F,$FF,$FF,$7F,$5F,$77,$5D,$57
.byte $FA,$FE,$F6,$D2,$46,$12,$42,$12
.byte $5D,$57,$55,$57,$55,$57,$55,$55
.byte $42,$02,$42,$02,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $55,$55,$55,$55,$55,$55,$54,$53
.byte $02,$02,$02,$02,$02,$02,$02,$82
.byte $4F,$3F,$FF,$FF,$7F,$5F,$77,$5D
.byte $E2,$FA,$FE,$F6,$D2,$46,$12,$42
.byte $57,$5D,$57,$55,$57,$55,$57,$55
.byte $12,$42,$02,$42,$02,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $55,$55,$55,$55,$55,$55,$55,$54
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $53,$4F,$3F,$FF,$FF,$7F,$5F,$77
.byte $82,$E2,$FA,$FE,$F6,$D2,$46,$12
.byte $5D,$57,$5D,$57,$55,$57,$55,$57
.byte $42,$12,$42,$02,$42,$02,$02,$02
.byte $55,$55,$55,$55,$55,$55,$55,$55
.byte $02,$02,$02,$02,$02,$02,$02,$02
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA
.byte $AA,$AA,$AA,$AA,$AA,$AA,$AA,$AA

// =============================================================================
// SPRITE DATA (bottom border visual)
// =============================================================================

* = SPRITE_DATA_ADDRESS "Sprite"
.fill 64, $50

// =============================================================================
// SCREENS (double buffer)
// =============================================================================

* = SCREEN0_ADDRESS "Screen 0"
    .fill $400, $00

* = SCREEN1_ADDRESS "Screen 1"
    .fill $400, $00

// -----------------------------------------------------------------------------
// Top-border text: font, scroll text, and the 8 rendered text sprites. These are
// VIC-bank-relative, so they relocate with the graphics bank. The font and scroll
// text are filled by the exporter (font is used only when fontMode != 0; an empty
// scroll text leaves this zeroed and the scroller stays off); the text sprites are
// rendered at runtime by RenderTextSprites.
// -----------------------------------------------------------------------------

* = RAM_CHARSET_ADDRESS "Text Font"
    .fill $300, $00                 // injected 1x1 font (96 chars), when fontMode != 0

* = SCROLLTEXT_ADDR "Scroll Text"
    .fill $400, $00                 // injected, null-terminated; empty = no scroller

* = SPRITES_ADDRESS "Text Sprites"
    .fill $200, $00                 // 8 x 64 bytes, filled by RenderTextSprites

// =============================================================================
// END OF FILE
// =============================================================================
