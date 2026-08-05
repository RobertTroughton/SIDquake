// =============================================================================
//                               MUSICAL BLOBS
//          Per-channel SID spectrum painted as a blended colour field
//
//   The top 96px hold a CHARACTER-mode logo (11 char rows) with the song name
//   written beneath it (row 11) using an injected 1x1 font. A raster split
//   then switches to multicolour BITMAP mode for the spectrum: one black
//   separator char row, then three contiguous 32px bands (Y104..199), one per
//   SID channel (voice idx % 3).
//
//   Why the split: charset logos are often "mixed" - many cells are
//   single-colour hires cells (colour RAM bit 3 clear), which multicolour
//   bitmap mode cannot represent. Character mode supports the per-cell
//   hires/multicolour escape, so the top region runs in char mode and only the
//   spectrum runs in bitmap mode. Both modes share $d018 == $68 (screen $1800,
//   charset/bitmap base $2000), so the split only toggles $d011 bit 5 (BMM).
//
//   40 bars per channel - one bar per 8px char column. Each bar's height scales
//   into its channel's colour ramp; the static bitmap's $66/$99 dither blends
//   two adjacent ramp entries (upper nibble = ramp[s], lower = ramp[s+1]). Only
//   the screen-RAM nibbles change each frame.
//
//   The bar area + separator never use %00 (which would show $d021). Their
//   "black" comes from %11 -> colour RAM ($d800), which is kept $00 there. That
//   frees $d021 to be the logo's %00 colour (black), independent of the bars.
//
//   The logo is not baked in. prg-builder converts the selected PNG with
//   charsetlab-core at export time (Mixed / Multicolour text mode, up to 159
//   chars) and injects charset, screen rows 0..10, colour-RAM staging and the
//   $d021/$d022/$d023 register values (data block $0E/$71/$72). The song-name
//   font (chars $A0..$FF) is likewise blank in the assembled binary;
//   prg-builder injects the selected 1x1 font at export.
//
//   BITMAP logos are also supported (logo mode byte at data block $70: 0=MC
//   bitmap, 1=hires bitmap, 2+=text). A bitmap logo and the spectrum share ONE
//   continuous bitmap at $2000: the logo fills rows 0..10 ($2000..$2DBF) and
//   the spectrum's baked patterns already sit at rows 12..24 ($2F00+), so
//   $d018 never changes - only $d011/$d016 differ per mode. The exception is
//   the song-name row 11, which stays in character mode: with a bitmap logo,
//   $d018's char slot ($2000) IS logo data, so a small raster window flips
//   row 11 to text with the font's second copy at $1000 (glyphs $A0..$FF =
//   $1500..$17FF, injected between the code and the screen).
//
//   VIC bank restriction: in banks 0 and 2 the VIC reads the character ROM at
//   bank+$1000..$1FFF, which shadows BOTH this player's screen ($1800) and the
//   alt font ($1500) - so MusicalBlobs only ever works in banks 1 and 3. The
//   relocating exporter refuses banks 0/2 automatically (char-ROM check), and
//   the config offers no fixed bank8000 layout (bank 2) for the same reason.
// =============================================================================

.var LOAD_ADDRESS                   = cmdLineVars.get("loadAddress").asNumber()
.var CODE_ADDRESS                   = cmdLineVars.get("sysAddress").asNumber()
.var DATA_ADDRESS                   = cmdLineVars.get("dataAddress").asNumber()

// =============================================================================
// CONFIGURATION CONSTANTS (needed before the includes)
// =============================================================================

.const NUM_FREQUENCY_BARS               = 40
.const NUM_CHANNELS                     = 3

//; Per-channel "height" range. Heights only ever index the colour ramps, never
//; drawn, so 0..MAX_BAR_HEIGHT just sets colour resolution + dynamics tuning.
.const TOP_SPECTRUM_HEIGHT              = 6
.const MAX_BAR_HEIGHT                   = TOP_SPECTRUM_HEIGHT * 8 - 1     // 47

.const BAR_INCREASE_RATE                = ceil(TOP_SPECTRUM_HEIGHT * 1.3) // 8
.const BAR_DECREASE_RATE                = ceil(TOP_SPECTRUM_HEIGHT * 0.6) // 4

// =============================================================================
// SCREEN LAYOUT (char rows; 25 rows total, 8px each)
//   rows  0..10 : logo (88px, Y0..87)         - CHARACTER mode
//   row     11  : song name (Y88..95)         - CHARACTER mode, 1x1 font
//   row     12  : black separator (Y96..103)  - the switch happens here
//   rows 13..16 : band 0  (channel 0)   32px  Y104..135   - BITMAP mode
//   rows 17..20 : band 1  (channel 1)   32px  Y136..167   - BITMAP mode
//   rows 21..24 : band 2  (channel 2)   32px  Y168..199   - BITMAP mode
//   No gaps between bands; the bands fill exactly to Y199.
// =============================================================================

.const LOGO_CHAR_ROWS                   = 11                                   // rows 0..10
.const SONGNAME_ROW                     = LOGO_CHAR_ROWS                       // row 11 (1x1 font)
.const SEPARATOR_ROW                    = SONGNAME_ROW + 1                     // row 12 (black)
.const BAND_CHAR_ROWS                   = 4
.const BAND0_ROW                        = SEPARATOR_ROW + 1                    // 13
.const BAND1_ROW                        = BAND0_ROW + BAND_CHAR_ROWS           // 17
.const BAND2_ROW                        = BAND1_ROW + BAND_CHAR_ROWS           // 21

.const LOGO_SCREEN_BYTES                = LOGO_CHAR_ROWS * 40                  // 440

//; The last char slot of the logo charset region ($2000..$24FF = 160 chars).
//; The exporter caps converted logos at 159 chars, so slot 159's glyph is
//; always $00 (blank) and the separator row renders black in character mode
//; too (during the split seam).
.const BLANK_CHAR_INDEX                 = 159

//; Song-name font: 96 glyphs at screen codes $A0..$FF (charset offset
//; $500..$7FF). The logo only uses chars 0..158, so the two never collide.
//; prg-builder injects the user-selected 1x1 font here at export time; the
//; data block's SongName screen codes (0..95) are remapped by adding the base.
.const FONT_BASE_CHAR                   = $A0
.const FONT_CHARSET_OFFSET              = FONT_BASE_CHAR * 8                   // $500
.const SONGNAME_COLUMN                  = 4     // 32-char field centered in 40 columns
.const SONGNAME_COLOUR                  = $01   // white; must be < 8 so the cell stays hires

// =============================================================================
// RASTER SPLIT
//   BOTTOM_RASTER : below the visible area (row 24 ends at line 250). Play
//                   music and switch back to character mode for the next frame.
//   SPLIT_RASTER  : start of the separator row 12 (line 51 + 12*8 = 147). Switch
//                   to bitmap mode. Row 12 is black in both modes, so the exact
//                   position of the switch inside it is not visible.
// =============================================================================

.const BOTTOM_RASTER                    = 252
.const SPLIT_RASTER                     = 147

//; Last raster line of logo row 10 (51 + 11*8 - 1); anchors the curtain.
.const NAME_SPLIT_RASTER                = 138

//; Sprite curtain (ALL logo modes): 7 x-expanded border-coloured sprites
//; whose last two rows block the logo's final two raster lines. The seam IRQ
//; (NameIRQ for bitmap logos, NameColourIRQ for text logos) has both hidden
//; lines for its VIC writes - no cycle counting, no visible seam. This also
//; hides the new-VIC (856x) grey-dot flash a $d021 write emits even when the
//; value is unchanged: the write lands on the curtained lines. The row-12
//; split needs no curtain: the separator row is black in both modes and
//; changes no colour registers.
//; Both the curtain sprite (its first data row shows one line below its Y) and
//; the NameIRQ VIC switch (IRQ latency delays the $d011 write) land ~1 line late,
//; so the seam sat 1px low over the song name; CURTAIN_TOP_BLOCK_LINE biases the
//; block up one line (NAME_SPLIT_RASTER - 2) to compensate.
//; The IRQ line is decoupled from the sprite: fired AT the block line, the VIC
//; switch still landed one line ABOVE the sprite rows (visible glitch, and a
//; logo line lost early). Arming one line below the block top
//; (CURTAIN_IRQ_LINE) puts the switch inside the curtained pair and lets the
//; bitmap keep that extra line.
.const CURTAIN_TOP_BLOCK_LINE           = NAME_SPLIT_RASTER - 2
.const CURTAIN_IRQ_LINE                 = CURTAIN_TOP_BLOCK_LINE + 1
.const CURTAIN_SPRITE_Y                 = CURTAIN_TOP_BLOCK_LINE - 19

// =============================================================================
// DATA BLOCK
//   The first $100 bytes of DATA_ADDRESS are the contract with prg-builder.js
//   (SID JMPs, song info, NumSIDChips, BorderColour @ $0d, ...). prg-builder
//   fills them in at export time.
// =============================================================================

* = DATA_ADDRESS "Data Block"
    .fill $100, $00

* = CODE_ADDRESS "Main Code"

#if !GFX_DONOR
    jmp Initialize
#endif

//; Graphics VIC bank, decoupled from the code load address so a CODE_ONLY build
//; can assemble the code apart from the graphics (exporter places them
//; independently). Classic build derives it from the load address - output
//; unchanged; CODE_ONLY takes an optional :gfxBank= for the reloc tooling.
#if CODE_ONLY
.var GFX_BANK = cmdLineVars.containsKey("gfxBank") ? cmdLineVars.get("gfxBank").asNumber() : 1
#else
.var GFX_BANK = floor(LOAD_ADDRESS / $4000)
#endif
.var VIC_BANK                       = GFX_BANK
.var VIC_BANK_ADDRESS               = VIC_BANK * $4000

// =============================================================================
// VIC MEMORY MAP (within the 16KB VIC bank)
//   $0000..$17FF : code + data + tables   (this file)
//   $1800..$1BFF : screen RAM (video matrix): rows 0..10 logo char codes,
//                  row 11 song name, row 12 blank char, rows 13..24 bitmap
//                  colour nibbles
//   $1C00..$1DFF : logo colour staging     (copied to $d800 rows 0..11)
//   $2000..$24FF : logo charset (up to 159 chars; slot 159 stays blank)
//   $2500..$27FF : song-name font (chars $A0..$FF, injected by prg-builder)
//   $2800..$2DFF : unused
//   $2E00..$2E3F : curtain sprite (one frame; see CURTAIN_SPRITE_DATA)
//   $2F00..$3F3F : spectrum bitmap (rows 12..24)
//
//   Character mode ($d018 bits 3-1 = charset $2000) and bitmap mode ($d018
//   bit 3 = bitmap $2000) both resolve to $d018 == $68, so only $d011 BMM
//   toggles at the split.
// =============================================================================

.const SCREEN_BANK                      = 6                                   // $1800
.const CHARSET_SLOT                     = 4                                   // $2000 (text mode)
.const BITMAP_BANK                      = 1                                   // $2000 (bitmap mode)

.const SCREEN_ADDRESS                   = VIC_BANK_ADDRESS + (SCREEN_BANK * $400)
.const LOGO_COLOR_STAGING               = VIC_BANK_ADDRESS + $1C00
.const CHARSET_ADDRESS                  = VIC_BANK_ADDRESS + (CHARSET_SLOT * $800)
.const BITMAP_ADDRESS                   = VIC_BANK_ADDRESS + (BITMAP_BANK * $2000)

//; Character mode: screen<<4 | charset<<1.  Bitmap mode: screen<<4 | bitmap<<3.
//; With charset slot 4 and bitmap bank 1 these are identical ($68).
.const D018_VALUE                       = (SCREEN_BANK * 16) + (CHARSET_SLOT * 2)
.errorif (D018_VALUE != (SCREEN_BANK * 16) + (BITMAP_BANK * 8)), "Charset and bitmap $d018 values must match for the raster split"

//; Bitmap-logo exports: during the row-11 song-name window the charset comes
//; from slot 2 ($1000). Row 11 only holds codes $A0..$FF, whose glyphs sit at
//; $1500..$17FF - free RAM between the code and the screen, where prg-builder
//; injects a second copy of the 1x1 font (charsetAltAddress).
.const SONGNAME_ALT_CHARSET_SLOT        = 2
.const D018_SONGNAME                    = (SCREEN_BANK * 16) + (SONGNAME_ALT_CHARSET_SLOT * 2)

//; Curtain sprite data: the free gap between the song-name font and the
//; spectrum bitmap. Pointer is bank-relative, so one constant fits every bank.
.const CURTAIN_SPRITE_DATA              = VIC_BANK_ADDRESS + $2E00
.const CURTAIN_SPRITE_PTR               = $2E00 / $40                          // $B8

// =============================================================================
// INCLUDES
// =============================================================================

#define INCLUDE_SPACE_FASTFORWARD
#define INCLUDE_PLUS_MINUS_SONGCHANGE
#define INCLUDE_09ALPHA_SONGCHANGE
#define INCLUDE_F1_SHOWRASTERTIMINGBAR
#define INCLUDE_MUSIC_ANALYSIS

#define INCLUDE_RASTER_TIMING_CODE
.var DEFAULT_RASTERTIMING_Y = 250

.import source "../INC/common.asm"
.import source "../INC/keyboard.asm"
.import source "../INC/musicplayback.asm"
.import source "../INC/stablerastersetup.asm"
.import source "../INC/spectrometer3channel.asm"
.import source "../INC/freqtable.asm"
.import source "../INC/linkedwitheffect.asm"

//; Graphics-donor build (-define GFX_DONOR): all runtime code is compiled
//; out - the full-bank bin only donates the data block + VIC assets to the
//; relocating exporter, so code size is never capped by the bank layout.
#if !GFX_DONOR


// =============================================================================
// PER-CHANNEL CHANGE TRACKING
//   One previous screen-byte per bar/column (40), per channel. Initialised to
//   $ff so the first render writes every column.
// =============================================================================

prevCh0:    .fill NUM_FREQUENCY_BARS, $ff
prevCh1:    .fill NUM_FREQUENCY_BARS, $ff
prevCh2:    .fill NUM_FREQUENCY_BARS, $ff

// =============================================================================
// COLOUR RAMPS - ONE PER CHANNEL
//   Three ramps (channel 0 red/fire, 1 green, 2 blue->cyan). Each bar's height
//   is scaled into its channel's ramp, and the bitmap's $66/$99 dither blends
//   two ADJACENT ramp entries together:
//       upper nibble = ramp[s]   (bitmap %01 pixels)
//       lower nibble = ramp[s+1] (bitmap %10 pixels)
//   so the colour climbs smoothly with intensity. The ramps are interleaved
//   (repeating each colour while cross-fading to the next) for soft transitions.
//   heightToByteChN[height] precombines into the ready-to-store screen byte;
//   height 0 -> black. All three ramps must be the same length.
// =============================================================================

.var rampCh0 = List().add(0, 11, 2, 11, 2, 11, 2, 10, 2, 10, 2, 10,  7, 10,  7, 10,  7, 1,  7, 1,  7, 1, 1)   // red / fire
.var rampCh1 = List().add(0,  9, 5,  9, 5,  9, 5, 13, 5, 13, 5, 13, 15, 13, 15, 13, 15, 1, 15, 1, 15, 1, 1)   // green
.var rampCh2 = List().add(0,  6, 4,  6, 4,  6, 4,  3, 4,  3, 4,  3,  7,  3,  7,  3,  7, 1,  7, 1,  7, 1, 1)   // blue -> cyan

.function rampByte(ramp, h) {
    .if (h == 0) .return $00
    .var s = floor((h - 1) * (ramp.size() - 2) / (MAX_BAR_HEIGHT - 1))  // 0 .. size-2
    .return (ramp.get(s) << 4) | ramp.get(s + 1)
}

.errorif (rampCh0.size() != rampCh1.size() || rampCh1.size() != rampCh2.size()), "Channel colour ramps must all be the same length"

heightToByteCh0:
    .for (var h = 0; h <= MAX_BAR_HEIGHT; h++) .byte rampByte(rampCh0, h)
heightToByteCh1:
    .for (var h = 0; h <= MAX_BAR_HEIGHT; h++) .byte rampByte(rampCh1, h)
heightToByteCh2:
    .for (var h = 0; h <= MAX_BAR_HEIGHT; h++) .byte rampByte(rampCh2, h)

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

    jsr SetupBitmapDisplay

    jsr DrawSongName
    jsr InitSongTimer

    jsr ClearBarState

    jsr SetupMusic

    lda #<BottomIRQ
    sta $fffe
    lda #>BottomIRQ
    sta $ffff

    lda #$01
    sta $d01a
    sta $d019
    lda #BOTTOM_RASTER
    sta $d012

    jsr VSync

    ldx BitmapMode              //; logo mode: char or bitmap for the top region
    lda LogoD011Table, x
    sta $d011

    cli

MainLoop:
    jsr CheckKeyboard

    lda visualizationUpdateFlag
    beq MainLoop

    jsr ApplySmoothing
    jsr RenderBars

    lda #$00
    sta visualizationUpdateFlag

    jmp MainLoop

//; The name is centre-padded with spaces in the data block; render it flush-left
//; from column 0 (skip the leading spaces) and truncate at 28 columns, so it
//; can't run into the elapsed timer / song length at columns 29+. Screen codes
//; 0..95 are remapped onto the song-name font at $A0..$FF; the colour RAM for
//; the 28 name cells is set to the (hires, <8) song-name colour.
.const SONGNAME_WIDTH = 28
DrawSongName:
    ldx #$ff
!lead:
    inx
    cpx #SONGNAME_WIDTH
    bcs !copy+                          //; all spaces -> render a blank line
    lda SongName, x
    cmp #$20                            //; screen-code space
    beq !lead-
!copy:
    ldy #$00
!cp:
    lda #$20                            //; past the name -> space
    cpx #32
    bcs !put+
    lda SongName, x
!put:
    clc
    adc #FONT_BASE_CHAR
    sta SCREEN_ADDRESS + (SONGNAME_ROW * 40) + 0, y
    lda #SONGNAME_COLOUR
    sta $d800 + (SONGNAME_ROW * 40) + 0, y
    inx
    iny
    cpy #SONGNAME_WIDTH
    bne !cp-
    rts

// =============================================================================
// SONG TIMER
//   Elapsed MM:SS at columns 29..33 of the song-name row, and (when the analysis
//   found a loop) a "/MM:SS" song length at columns 34..39 - the same left-name /
//   right-timer layout the RaistlinBars players use. Self-contained rather than
//   shared with INC/timer.asm, because that timer draws a 1x2 (double-height) bar
//   font, whereas this player's song row is a 1x1 HIRES font at $A0..$FF: digits
//   are the song-name font's own glyphs (screen code = FONT_BASE_CHAR + '0'..'/').
//   The clock snaps back to the loop point when it reaches the length, so it never
//   runs past the shown "/MM:SS" (second granularity).
// =============================================================================
.const TIMER_ROW_OFFSET  = SONGNAME_ROW * 40
.const TIMER_ELAPSED_COL = 29                       //; MM:SS at 29..33
.const TIMER_SLASH_COL   = 34                       //; '/'
.const TIMER_LENGTH_COL  = 35                       //; MM:SS length at 35..39
//; With no length to sit beside it, the clock moves to where the length would
//; have been, so it still ends at the right-hand edge instead of stranding six
//; blank columns between itself and the border.
.const TIMER_ELAPSED_COL_ALONE = TIMER_LENGTH_COL   //; no length: flush-right
.const TIMER_COLOUR      = SONGNAME_COLOUR          //; must be < 8 to stay hires
.const TIMER_FPS         = 50                       //; this player is PAL-only
.const T_DIGIT0          = FONT_BASE_CHAR + 48      //; '0' glyph in the song font
.const T_COLON           = FONT_BASE_CHAR + 58      //; ':'
.const T_SLASH           = FONT_BASE_CHAR + 47      //; '/'

//; Length / loop fields, injected by prg-builder (patchSongLengthFields) at the
//; same data-block offsets the RaistlinBars family uses; zero when no length.
.label bakedLoopEndMin = DATA_ADDRESS + $4C
.label bakedLoopEndSec = DATA_ADDRESS + $4D
.label bakedLoopMin    = DATA_ADDRESS + $5B
.label bakedLoopSec    = DATA_ADDRESS + $5C
.label bakedLenMin     = DATA_ADDRESS + $5D
.label bakedLenSec     = DATA_ADDRESS + $5E
.label bakedHasLength  = DATA_ADDRESS + $5F

TimerFrames:  .byte $00
TimerSeconds: .byte $00
TimerMinutes: .byte $00
fmtMin:       .byte $00
fmtSec:       .byte $00
fmtBuf:       .fill 5, $00

//; A (0..99) -> X = tens, A = ones
TimerDiv10:
    ldx #$ff
!loop:
    inx
    sec
    sbc #10
    bcs !loop-
    adc #10
    rts

//; fmtMin/fmtSec -> fmtBuf: five song-font screen codes "MM:SS".
FormatTime:
    lda fmtMin
    jsr TimerDiv10
    pha
    txa
    clc
    adc #T_DIGIT0
    sta fmtBuf + 0
    pla
    clc
    adc #T_DIGIT0
    sta fmtBuf + 1
    lda #T_COLON
    sta fmtBuf + 2
    lda fmtSec
    jsr TimerDiv10
    pha
    txa
    clc
    adc #T_DIGIT0
    sta fmtBuf + 3
    pla
    clc
    adc #T_DIGIT0
    sta fmtBuf + 4
    rts

//; Both elapsed-time columns are fixed constants, so the two stores are just
//; branched to - no self-modify (the same shape as INC/timer.asm's timerAlone).
DrawSongTimer:
    lda TimerMinutes
    sta fmtMin
    lda TimerSeconds
    sta fmtSec
    jsr FormatTime
    lda bakedHasLength
    beq !alone+
    ldx #4
!write:
    lda fmtBuf, x
    sta SCREEN_ADDRESS + TIMER_ROW_OFFSET + TIMER_ELAPSED_COL, x
    dex
    bpl !write-
    rts
!alone:
    ldx #4
!writeR:
    lda fmtBuf, x
    sta SCREEN_ADDRESS + TIMER_ROW_OFFSET + TIMER_ELAPSED_COL_ALONE, x
    dex
    bpl !writeR-
    rts

//; Colour the five elapsed-time cells, in whichever column the clock is using.
ColourSongTimer:
    lda bakedHasLength
    beq !alone+
    ldx #4
!colour:
    lda #TIMER_COLOUR
    sta $d800 + TIMER_ROW_OFFSET + TIMER_ELAPSED_COL, x
    dex
    bpl !colour-
    rts
!alone:
    ldx #4
!colourR:
    lda #TIMER_COLOUR
    sta $d800 + TIMER_ROW_OFFSET + TIMER_ELAPSED_COL_ALONE, x
    dex
    bpl !colourR-
    rts

//; Zero the clock, colour the elapsed cells, paint 00:00, then draw "/MM:SS".
InitSongTimer:
    lda #$00
    sta TimerFrames
    sta TimerSeconds
    sta TimerMinutes
    jsr ColourSongTimer
    jsr DrawSongTimer
    // fall through into DrawSongLength

//; Static "/MM:SS" length, drawn once (no-op when no length was found).
DrawSongLength:
    lda bakedHasLength
    bne !show+
    rts
!show:
    lda #T_SLASH
    sta SCREEN_ADDRESS + TIMER_ROW_OFFSET + TIMER_SLASH_COL
    lda #TIMER_COLOUR
    sta $d800 + TIMER_ROW_OFFSET + TIMER_SLASH_COL
    lda bakedLenMin
    sta fmtMin
    lda bakedLenSec
    sta fmtSec
    jsr FormatTime
    ldx #4
!write:
    lda fmtBuf, x
    sta SCREEN_ADDRESS + TIMER_ROW_OFFSET + TIMER_LENGTH_COL, x
    lda #TIMER_COLOUR
    sta $d800 + TIMER_ROW_OFFSET + TIMER_LENGTH_COL, x
    dex
    bpl !write-
    rts

//; Once per visual frame. Snap to the loop point on reaching the length, else
//; advance the clock and redraw when the second changes.
UpdateSongTimer:
    lda bakedHasLength
    beq !tick+
    lda TimerMinutes
    cmp bakedLoopEndMin
    bcc !tick+
    bne !wrap+
    lda TimerSeconds
    cmp bakedLoopEndSec
    bcc !tick+
!wrap:
    lda #$00
    sta TimerFrames
    lda bakedLoopMin
    sta TimerMinutes
    lda bakedLoopSec
    sta TimerSeconds
    jmp DrawSongTimer
!tick:
    inc TimerFrames
    lda TimerFrames
    cmp #TIMER_FPS
    bcc !done+
    lda #$00
    sta TimerFrames
    inc TimerSeconds
    lda TimerSeconds
    cmp #60
    bcc !draw+
    lda #$00
    sta TimerSeconds
    inc TimerMinutes
!draw:
    jmp DrawSongTimer
!done:
    rts

ClearBarState:
    ldy #$00
    lda #$00
!loop:
    sta barHeightsCh0 - 2, y
    sta barHeightsCh1 - 2, y
    sta barHeightsCh2 - 2, y
    sta smoothedHeightsCh0, y
    sta smoothedHeightsCh1, y
    sta smoothedHeightsCh2, y
    iny
    cpy #NUM_FREQUENCY_BARS + 4
    bne !loop-
    rts

// =============================================================================
// DISPLAY SETUP
//   - copy the embedded logo colour staging into $d800 (colour RAM rows 0..11)
//   - configure VIC registers shared by both halves of the split
//   The spectrum region of screen RAM is left as the assembled $00 (black) and
//   filled by the first render; the logo char codes/colours are embedded.
// =============================================================================

SetupBitmapDisplay:
    //; Colour RAM: clear all to black, then copy the logo colour staging into
    //; the logo rows. The separator + bar rows stay $00, so their %11 pixels are
    //; black regardless of $d021.
    ldx #$00
!clrColor:
    lda #$00
    sta $d800 + $000, x
    sta $d800 + $100, x
    sta $d800 + $200, x
    sta $d800 + $300, x
    inx
    bne !clrColor-

    ldx #$00
!colLoop:
    lda LOGO_COLOR_STAGING + $000, x
    sta $d800 + $000, x
    lda LOGO_COLOR_STAGING + $100, x
    sta $d800 + $100, x
    inx
    bne !colLoop-                          //; 512 bytes (logo rows 0..11 + pad)

    //; Sprites: the curtain over the row-10/11 seam, for every logo mode -
    //; the seam IRQ's VIC writes (and their grey-dot artefacts) must always
    //; land on the blocked lines.
    jsr SetupCurtainSprites

    ldx BitmapMode                         //; MCM for MC logos + spectrum; off for a hires-bitmap logo top
    lda LogoD016Table, x
    sta $d016

    lda #D018_VALUE
    sta $d018

    lda BorderColour
    sta $d020

    //; Logo %00 -> $d021. The bars never use %00, so $d021 is free for the
    //; logo's background (injected from the PNG conversion, data block $0E).
    lda BitmapScreenColour
    sta $d021

    //; Character-mode logo global colours: %01 -> $d022, %10 -> $d023, also
    //; injected from the PNG conversion. Bitmap mode ignores these registers.
    lda LogoD022
    sta $d022
    lda LogoD023
    sta $d023
    rts

// =============================================================================
// SPRITE CURTAIN SETUP (all logo modes)
//   7 x-expanded border-coloured sprites across the full width; transparent
//   except their last two rows, which land on the logo's final two raster
//   lines (the seam IRQ window).
// =============================================================================

SetupCurtainSprites:
    ldx #$06
    ldy #$0c                    //; sprite 6 first: $d00c/$d00d, down to $d000/$d001
!loop:
    lda CurtainXTable, x
    sta $d000, y
    lda #CURTAIN_SPRITE_Y
    sta $d001, y
    lda BorderColour
    sta $d027, x
    lda #CURTAIN_SPRITE_PTR
    sta SCREEN_ADDRESS + $3F8, x
    dey
    dey
    dex
    bpl !loop-
    lda #$60                    //; sprites 5 (264) and 6 (312) sit past the 256-line: MSBs set
    sta $d010
    lda #$7f
    sta $d01d                   //; x-expand all 7 (sprite 7 unused)
    lda #$00
    sta $d017                   //; no y-expand
    sta $d01c                   //; hires sprites
    sta $d01b                   //; in front of the graphics
    lda #$7f
    sta $d015                   //; curtain on
    rts

CurtainXTable: .byte 24, 72, 120, 168, 216, 264 - 256, 312 - 256

// =============================================================================
// BOTTOM INTERRUPT (line BOTTOM_RASTER)
//   The spectrum has finished displaying. Switch back to character mode for the
//   next frame's logo, play music, run the analysis + bar update, then arm the
//   split interrupt.
// =============================================================================

BottomIRQ:
    pha
    txa
    pha
    tya
    pha
    lda $01
    pha
    lda #$35
    sta $01

    ldx BitmapMode              //; top-region mode for the next frame: char for
    lda LogoD011Table, x        //; text logos, bitmap for bitmap logos (the
    sta $d011                   //; spectrum bitmap simply follows the logo)
    lda LogoD016Table, x
    sta $d016
    lda BitmapScreenColour      //; the logo owns $d021; the song-name split
    beq !skipD021+              //; blackened it, so restore for the next frame.
    sta $d021                   //; Skipped for black logo bgs: $d021 already
!skipD021:                      //; holds 0, and this write sits in the visible
                                //; lower border where no sprite can hide the
                                //; new-VIC grey dot it would emit.

    lda FastForwardActive
    beq !normalPlay+

!ffFrameLoop:
    lda NumCallsPerFrame
    sta FFCallCounter

!ffCallLoop:
    jsr SIDPlay
    inc $d020
    dec FFCallCounter
    bne !ffCallLoop-

    //; Each pass above is one music frame's worth of play calls, so everything
    //; that counts music frames advances at the same accelerated rate - the
    //; forced song loop, and the clock, which would otherwise stand still and
    //; fall behind the audio for as long as SPACE is held.
    jsr CheckMusicLoop
    jsr UpdateSongTimer
    jsr CheckSpaceKey
    lda FastForwardActive
    bne !ffFrameLoop-

    lda BorderColour
    sta $d020
    jmp !arm+

!normalPlay:
    inc visualizationUpdateFlag

    inc frameCounter
    bne !skip+
    inc frame256Counter
!skip:

    //; Forced song loop: tick once per frame; carry set = the tune was just
    //; restarted, so skip this frame's play call (see INC/musicplayback.asm).
    jsr CheckMusicLoop
    bcs !skipPlay+
    jsr JustPlayMusic
    jsr AnalyseMusic
!skipPlay:
    jsr UpdateBars
    jsr UpdateSongTimer

!arm:
    //; Both logo kinds arm their seam IRQ inside the curtained pair of lines
    //; (CURTAIN_IRQ_LINE). Bitmap logos: the row-11 window (song name in char
    //; mode) first, which then arms the split. Text logos: only the song-name
    //; row's $d021 (it must not inherit the logo's background), then the split.
    ldx BitmapMode
    cpx #$02
    bcs !charLogo+
    lda #<NameIRQ
    sta $fffe
    lda #>NameIRQ
    sta $ffff
    jmp !armed+
!charLogo:
    lda #<NameColourIRQ
    sta $fffe
    lda #>NameColourIRQ
    sta $ffff
!armed:
    lda #CURTAIN_IRQ_LINE
    sta $d012

    lda #$01
    sta $d019

    pla
    sta $01
    pla
    tay
    pla
    tax
    pla
    rti

// =============================================================================
// SPLIT INTERRUPT (line SPLIT_RASTER)
//   Row 11 (the song-name row) has displayed; switch to multicolour bitmap
//   mode for the spectrum bands, then arm the bottom interrupt. Only A is used,
//   so the handler stays short.
// =============================================================================

SplitIRQ:
    pha

    lda #$3b                    //; bitmap mode, screen on, yscroll 3
    sta $d011
    lda #D018_VALUE             //; back to screen $1800 + bitmap $2000 (undoes
    sta $d018                   //; the row-11 window; no-op for text logos)
    lda #$18                    //; multicolour on for the spectrum
    sta $d016

    lda #<BottomIRQ
    sta $fffe
    lda #>BottomIRQ
    sta $ffff
    lda #BOTTOM_RASTER
    sta $d012

    lda #$01
    sta $d019

    pla
    rti

// =============================================================================
// SONG-NAME INTERRUPT (bitmap logos only; line CURTAIN_IRQ_LINE)
//   Rows 0..10 have displayed as bitmap. The curtain sprites hide this line
//   and the next, so the switch to character mode (charset at $1000 - row 11
//   draws the song name from the font's second copy) just writes the
//   registers; whatever renders on the blocked lines is invisible. SplitIRQ
//   restores bitmap mode for the spectrum at row 12.
// =============================================================================

NameIRQ:
    pha

    lda #$1b
    sta $d011
    lda #D018_SONGNAME
    sta $d018
    lda #$00                    //; song-name row: black background, not the
    sta $d021                   //; logo's (the curtain hides this write too)

    lda #<SplitIRQ
    sta $fffe
    lda #>SplitIRQ
    sta $ffff
    lda #SPLIT_RASTER
    sta $d012

    lda #$01
    sta $d019

    pla
    rti

// =============================================================================
// TEXT-LOGO SONG-NAME COLOUR INTERRUPT (line CURTAIN_IRQ_LINE)
//   Text logos stay in character mode into row 11, but the song-name row must
//   not show the logo's $d021 background. The curtain sprites hide this line
//   and the next, so the write needs no cycle timing - and the grey dot a
//   $d021 write flashes on new VICs (even when the value is unchanged) lands
//   on the blocked lines instead of the visible border. SplitIRQ takes over
//   at row 12.
// =============================================================================

NameColourIRQ:
    pha

    lda #$00
    sta $d021

    lda #<SplitIRQ
    sta $fffe
    lda #>SplitIRQ
    sta $ffff
    lda #SPLIT_RASTER
    sta $d012

    lda #$01
    sta $d019

    pla
    rti

// =============================================================================
// RENDERING
//   One bar per char column (40 cols). screen byte = (Cn << 4) | Cn-1:
//     upper nibble Cn   -> bitmap %01 pixels (right half solid + half the left)
//     lower nibble Cn-1 -> bitmap %10 pixels (the other half of the left dither)
//   Cn-1 starts at black for the far-left column. Per-column change detection;
//   a changed colour also dirties the column to its right (handled because the
//   right column compares its own combined byte too).
// =============================================================================

.macro RenderChannel(smoothedH, byteTable, prevByte, topRow) {
    ldx #NUM_FREQUENCY_BARS - 1
!loop:
    ldy smoothedH, x
    lda byteTable, y            //; (ramp[s] << 4) | ramp[s+1]
    cmp prevByte, x
    beq !skip+
    sta prevByte, x
    sta SCREEN_ADDRESS + ((topRow + 0) * 40), x
    sta SCREEN_ADDRESS + ((topRow + 1) * 40), x
    sta SCREEN_ADDRESS + ((topRow + 2) * 40), x
    sta SCREEN_ADDRESS + ((topRow + 3) * 40), x
!skip:
    dex
    bpl !loop-
}

RenderBars:
    RenderChannel(smoothedHeightsCh0, heightToByteCh0, prevCh0, BAND0_ROW)
    RenderChannel(smoothedHeightsCh1, heightToByteCh1, prevCh1, BAND1_ROW)
    RenderChannel(smoothedHeightsCh2, heightToByteCh2, prevCh2, BAND2_ROW)
    rts

// =============================================================================
// MUSIC SETUP
// =============================================================================

SetupMusic:
    jsr InitMusicLoop           // arm the forced-loop countdown (no-op when disabled)

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
// ANIMATION STATE
// =============================================================================

visualizationUpdateFlag:    .byte $00
frameCounter:               .byte $00
frame256Counter:            .byte $00

//; Top-region $d011/$d016 by logo mode (data block $70):
//;   0 = MC bitmap, 1 = hires bitmap, 2 = hires text, 3 = MC/mixed text, 4 = ECM
LogoD011Table:              .byte $3b, $3b, $1b, $1b, $5b
LogoD016Table:              .byte $18, $08, $08, $18, $08

#endif // !GFX_DONOR (code)

//; The song-name alt font (injected at charsetAltAddress) starts at $1500 in
//; the VIC bank; the code must stay below it.
#if !CODE_ONLY
.errorif (* > VIC_BANK_ADDRESS + $1500), "Main Code overruns the song-name alt font at bank+$1500"
#endif

// =============================================================================
// SCREEN RAM + LOGO COLOUR STAGING
//   Screen rows 0..10 hold the logo char codes (read in character mode); row 11
//   holds the song name (font spaces until DrawSongName runs); row 12 is a
//   blank char (renders black at the split seam); rows 13..24 hold the bitmap
//   colour nibbles written by the bar renderer.
//   The logo areas assemble as zeros; prg-builder injects the converted PNG's
//   char codes / colour RAM / charset at export time.
// =============================================================================

//; A CODE_ONLY build omits all of this - the exporter places the screen, logo
//; colour staging, charset, song-name font and bitmap into a VIC bank; the code
//; reaches LOGO_COLOR_STAGING and the rest via gfx-refs (patched to the bank).
#if !CODE_ONLY

* = SCREEN_ADDRESS "Screen RAM"
    .fill LOGO_SCREEN_BYTES, $00                         //; rows 0..10 char codes (injected)
    .fill 40, FONT_BASE_CHAR + $20                       //; row 11 (song name; font space)
    .fill 40, BLANK_CHAR_INDEX                           //; row 12 (blank in char mode)
    .fill $400 - LOGO_SCREEN_BYTES - 80, $00             //; rows 13..24 (bar renderer)

* = LOGO_COLOR_STAGING "Logo Colour Staging"
    .fill LOGO_SCREEN_BYTES, $00                         //; rows 0..10 colour RAM (injected)
    .fill 40, SONGNAME_COLOUR                            //; row 11 (song name, hires)
    .fill $200 - LOGO_SCREEN_BYTES - 40, $00             //; pad to 512

// =============================================================================
// LOGO CHARSET + SPECTRUM BITMAP
//   The logo charset ($2000..$24FF) and the song-name font ($2500..$27FF)
//   occupy the top of the bitmap's 8KB region. Those bitmap bytes cover char
//   rows 0..6, which are never displayed in bitmap mode (character mode covers
//   rows 0..11), so the overlap is safe.
//   "Black" pixels in the bar area use %11 (-> colour RAM $d800 = $00) rather
//   than %00 (-> $d021), so they stay black independent of $d021. Per-cell
//   pattern bytes:
//       $ff = %11 11 11 11  all black (separator + the 2 scanlines per cell)
//       $66 = %01 10 01 10 / $99 = %10 01 10 01  full colour (both nibbles)
//       $77 = %01 11 01 11 / $dd = %11 01 11 01  faded (upper nibble + black)
//   Each band is 4 char rows: top & bottom faded ($77/$dd), middle two full
//   ($66/$99). Row 12 is a solid-black separator.
// =============================================================================

* = CHARSET_ADDRESS "Logo Charset"
    .fill $500, $00                                      //; up to 159 chars (injected); slot 159 stays blank

//; Song-name font (chars $A0..$FF). Blank in the assembled binary; prg-builder
//; overlays the selected 1x1 font (96 glyphs, 768 bytes) here at export time.
* = CHARSET_ADDRESS + FONT_CHARSET_OFFSET "Song Name Font"
SongNameFont:
    .fill $300, $00

.var patFull    = List().add($ff, $ff, $66, $99, $66, $99, $66, $99)
.var patFade    = List().add($ff, $ff, $77, $dd, $77, $dd, $77, $dd)
.var bandRowPat = List().add(patFade).add(patFull).add(patFull).add(patFade)

* = CURTAIN_SPRITE_DATA "Curtain Sprite"
    .fill 57, $00                                        //; rows 0-18 transparent
    .fill 6, $ff                                         //; rows 19-20 solid - the 2-line block
    .byte $00

* = BITMAP_ADDRESS + (SEPARATOR_ROW * 40 * 8) "Spectrum Bitmap"
    .for (var R = SEPARATOR_ROW; R < 25; R++) {
        .for (var c = 0; c < 40; c++) {
            .for (var p = 0; p < 8; p++) {
                .if (R == SEPARATOR_ROW) {
                    .byte $ff                               // black separator (all %11)
                } else {
                    .byte bandRowPat.get(mod(R - BAND0_ROW, BAND_CHAR_ROWS)).get(p)
                }
            }
        }
    }
    .fill (BITMAP_ADDRESS + $2000) - *, $00

#endif // !CODE_ONLY

// =============================================================================
// END OF FILE
// =============================================================================
