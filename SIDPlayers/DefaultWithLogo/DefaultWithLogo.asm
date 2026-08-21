// =============================================================================
//                         DEFAULT WITH LOGO
//              Text Details Player with a 9-row Logo at Top
// =============================================================================
//
// Memory Map:
//   DATA_ADDRESS + $000-$0FF  : Data Block (metadata, config)
//   CODE_ADDRESS              : Main Code
//   LOGO_SCREEN_ADDRESS       : logo screen codes / bitmap colour nibbles (360 bytes)
//   LOGO_COLOR_ADDRESS        : logo colour RAM data (360 bytes)
//
// The logo occupies screen rows 0-8 and can be ANY logo type: the exporter's
// CharSet Lab conversion writes a mode byte (data block $70) plus the
// $d021-$d024 register values, and injects either a charset (text modes) or
// bitmap rows 0-8 into the logo graphics region at VICBANK+$2000. PETSCII
// results ship no charset - the matching ROM set is copied at init instead.
// Info text is in rows 9-24.
//
// An IRQ split at the row 9 boundary switches the VIC per region:
//   - Logo area: $d018 -> logo graphics (charset $2000 and bitmap $2000
//     encode to the SAME $d018 value), $d011/$d016 from mode tables
//     (BMM for bitmap logos, ECM bit, MCM), $d021 = the logo's background.
//   - Info area: $d018 -> info charset, plain text mode, $d021 = the
//     user-chosen background colour.
// =============================================================================

.var LOAD_ADDRESS                   = cmdLineVars.get("loadAddress").asNumber()
.var CODE_ADDRESS                   = cmdLineVars.get("sysAddress").asNumber()
.var DATA_ADDRESS                   = cmdLineVars.get("dataAddress").asNumber()

// =============================================================================
// CONFIGURATION
// =============================================================================

.const LOGO_ROWS                    = 9
.const LOGO_COLS                    = 40
.const LOGO_CELLS                   = LOGO_ROWS * LOGO_COLS // 360
.const INFO_START_ROW               = 9
.const TOTAL_ROWS                   = 25

// =============================================================================
// VIC BANK / SCREEN / CHARSET LAYOUT
//
// The player runs from whichever VIC bank its code was assembled into
// (LOAD_ADDRESS / $4000). The screen and both charsets (the logo charset and
// the info charset, switched by the raster split) live inside that bank, so a
// SID that loads as low as $0400 is never overwritten by the display.
//
//   Bank 0   : screen $0400        logo gfx $2000  info cs $3800
//   Bank 1-3 : screen <bank>+$3000 logo gfx <bank>+$2000  info cs <bank>+$3800
//
// The logo graphics region is $2000-$2B3F: a text-mode charset uses the first
// $800, a bitmap logo fills all 9 rows x 320 bytes ($B40). The info charset
// sits at $3800 (slot 7) so a bitmap logo can never reach it.
//
// Both charsets are copied into RAM at init (the character ROM is only
// VIC-visible in banks 0 and 2, so banks 1 and 3 need a copy). A custom info
// font, if injected, overwrites the info charset after the intro.
// =============================================================================

// The VIC bank is decoupled from the code load address so a CODE_ONLY build can
// relocate the code (incl. the logo screen/colour tables and font source, all
// CPU-read) to any free page, while the screen + two charset RAMs (the only parts the
// VIC must fetch from a 16 KB bank) are reserved in their own bank by the exporter.
// The classic single-blob build derives the bank from the load address (output
// unchanged); CODE_ONLY takes an optional :gfxBank= for the reloc tooling.
#if CODE_ONLY
.var VIC_BANK           = cmdLineVars.containsKey("gfxBank") ? cmdLineVars.get("gfxBank").asNumber() : 1
#else
.var VIC_BANK           = floor(LOAD_ADDRESS / $4000)
#endif
.var VIC_BANK_ADDRESS   = VIC_BANK * $4000

.var SCREEN_RAM         = VIC_BANK_ADDRESS + $3000
.var LOGO_CHARSET_RAM   = VIC_BANK_ADDRESS + $2000
.var LOGO_GFX_SIZE      = LOGO_ROWS * 40 * 8            // $B40: bitmap rows 0-8 (a charset uses the first $800)
.var INFO_CHARSET_RAM   = VIC_BANK_ADDRESS + $3800
.var ScreenD018Nibble   = 12    // $3000 / $400
.if (VIC_BANK == 0) {
    .eval SCREEN_RAM       = $0400
    .eval ScreenD018Nibble = 1      // $0400 / $400
}
.var LogoCharsetNibble  = 4     // $2000 / $800
.var InfoCharsetNibble  = 7     // $3800 / $800
.var D018_LOGO          = (ScreenD018Nibble * 16) + (LogoCharsetNibble * 2)
.var D018_INFO          = (ScreenD018Nibble * 16) + (InfoCharsetNibble * 2)
.var D018_VALUE         = D018_INFO     // intro draws with the lowercase info charset

// The logo region uses ONE $d018 value for every mode: charset slot 4 encodes
// as bits 3-1 = %0100 = 8, and bitmap base $2000 encodes as bit 3 = 8.
.errorif (D018_LOGO != (ScreenD018Nibble * 16) + 8), "Logo charset/bitmap $d018 values must match"

// Logo mode byte (data block $70, from charsetlab-core's LOGO_MODES):
.const LOGO_MODE_PETSCII_UPPER      = 5
.const LOGO_MODE_PETSCII_LOWER      = 6

// Raster line where the split occurs: the last line of the logo's final
// character row. With the standard YSCROLL of 3 the first badline is 51, so
// character row N covers rasters 51 + N*8 .. 58 + N*8 - counting the first
// display line as 50 puts the whole split one line high, which leaves the
// logo's own last line rendering as text through the logo's video matrix.
.const FIRST_DISPLAY_LINE           = 51
.const SPLIT_RASTERLINE             = FIRST_DISPLAY_LINE + (LOGO_ROWS * 8) - 1

// =============================================================================
// SPRITE CURTAIN
// The logo/info split is hidden behind 7 x-expanded border-coloured sprites
// (48px * 7 = full width). The sprite is transparent except its last two rows,
// which block the logo's final two raster lines; the split IRQ fires on the
// first blocked line and has both hidden lines (~126 cycles) to rewrite the
// VIC - no cycle counting, no visible glitch, no flicker.
// =============================================================================

// Bias up one line (SPLIT_RASTERLINE - 2, not - 1): the curtain sprite renders
// one line below its Y, and the split IRQ's VIC write lands ~1 line late from IRQ
// latency, so both sat 1px low over the info line. CURTAIN_TOP_BLOCK_LINE drives
// the sprite Y AND the SplitIRQ $d012 (SetNextRasterEvent below), so moving it
// shifts the block and the switch together - the sprite keeps hiding the switch.
.const CURTAIN_TOP_BLOCK_LINE       = SPLIT_RASTERLINE - 2        // first of the 2 blocked lines
.const CURTAIN_SPRITE_Y             = CURTAIN_TOP_BLOCK_LINE - 19 // solid rows 19/20 land on the blocked lines
.var CURTAIN_SPRITE_DATA            = VIC_BANK_ADDRESS + $2C00    // free: between the logo graphics and the screen
.const CURTAIN_SPRITE_PTR           = $2C00 / $40                 // $B0 (bank-relative, same in every bank)

// =============================================================================
// DATA BLOCK
// =============================================================================

* = DATA_ADDRESS "Data Block"
    .fill $0D, $00                      // Reserved bytes 0-12
borderColor:
    .byte $00                           // Byte $0D: Border color
backgroundColor:
    .byte $00                           // Byte $0E: Background color
    .fill $70 - $0F, $00               // Reserved bytes $0F-$6F
logoMode:
    .byte $00                           // $70: logo mode (0=MC bmp, 1=HI bmp, 2=HI text, 3=MC text, 4=ECM, 5/6=PETSCII up/low)
    .fill 3, $00                        // $71-$73: logo $d022-$d024 (LogoD022/23/24 in common.asm)
logoBackground:
    .byte $00                           // $74: logo-area $d021 (the info area keeps backgroundColor)
fontMode:
    .byte $00                           // $75: 0=info uses ROM charset, 1=info uses injected RAM charset
bakedLenMin:
    .byte $00                           // $76: song length MM (patched at export; only when known)
bakedLenSec:
    .byte $00                           // $77: song length SS
bakedHasLength:
    .byte $00                           // $78: 1 when a real (single-song) length is known
    //; Frame-exact loop wrap. The elapsed clock already tracks an exact frame
    //; position as MM:SS:frame (FrameCounter is the sub-second frame). When it
    //; reaches the loop-END triple it snaps back to the loop-START triple, so it
    //; never runs past the length and the reset is frame-exact (no drift).
bakedLoopMin:
    .byte $00                           // $79: loop-start MM (reset target)
bakedLoopSec:
    .byte $00                           // $7A: loop-start SS
bakedLoopFrameRem:
    .byte $00                           // $7B: loop-start frame within that second
bakedLoopEndMin:
    .byte $00                           // $7C: loop-end MM (wrap trigger)
bakedLoopEndSec:
    .byte $00                           // $7D: loop-end SS
bakedLoopEndFrameRem:
    .byte $00                           // $7E: loop-end frame within that second
    .fill $100 - $7F, $00              // Fill rest

* = CODE_ADDRESS "Main Code"

#if !GFX_DONOR
    jmp Initialize
#endif

// =============================================================================
// DISPLAY LAYOUT - Info in rows 9-24 (16 rows, one item per line)
// =============================================================================
//
// All left-column colons aligned at col 14, values start at col 16.
// Right-column (row 21 only) colon at col 30, value at col 32.
//
//   Row  9:      Song Name (centered, 32 chars)
//   Row 10:      Artist (centered, 32 chars)
//   Row 11:      Copyright (centered, 32 chars)
//   Row 12: ----------------------------------------
//   Row 13:        Memory: $xxxx-$xxxx
//   Row 14:          Init: $xxxx
//   Row 15:          Play: $xxxx
//   Row 16:      ZP Usage: xxxxxxxxxxxxxxxxxxxxxxxx
//   Row 17:         Songs: xx
//   Row 18:         Clock: PAL
//   Row 19:           SID: 6581
//   Row 20: ----------------------------------------
//   Row 21:          Time: 00:00          Song: 01/xx
//   Row 22: ----------------------------------------
//   Row 23:   F1=Timing Bar   SPACE=Fast Forward
//   Row 24:   +/-=Next/Prev  1-9,A-Z=Select Song

.var Display_Title_Colour           = $01  // White
.var Display_Artist_Colour          = $0c  // Grey
.var Display_Copyright_Colour       = $0c  // Grey
.var Display_Separators_Colour      = $0b  // Dark Grey
.var Display_InfoTitles_Colour      = $0e  // Light Blue
.var Display_InfoValues_Colour      = $01  // White
.var Display_ControlsTitle_Colour   = $02  // Red
.var Display_ControlsInfo_Colour    = $04  // Purple

// Row positions - all colons at col 14, values at col 16
.var Display_Title_X                = 4
.var Display_Title_Y                = 9

.var Display_Artist_X               = 4
.var Display_Artist_Y               = 10

.var Display_Copyright_X            = 4
.var Display_Copyright_Y            = 11

.var Display_Separator1_Y           = 12

.var Display_Memory_X               = 8     // "Memory: " (8 chars) → colon at col 14
.var Display_Memory_Y               = 13

.var Display_Init_X                 = 10    // "Init: " (6 chars) → colon at col 14
.var Display_Init_Y                 = 14

.var Display_Play_X                 = 10    // "Play: " (6 chars) → colon at col 14
.var Display_Play_Y                 = 15

.var Display_ZP_X                   = 6     // "ZP Usage: " (10 chars) → colon at col 14
.var Display_ZP_Y                   = 16

.var Display_Songs_X                = 9     // "Songs: " (7 chars) → colon at col 14
.var Display_Songs_Y                = 17

.var Display_Clock_X                = 9     // "Clock: " (7 chars) → colon at col 14
.var Display_Clock_Y                = 18

.var Display_SID_X                  = 11    // "SID: " (5 chars) → colon at col 14
.var Display_SID_Y                  = 19

.var Display_Separator2_Y           = 20

.var Display_Time_X                 = 10    // "Time: " (6 chars) → colon at col 14
.var Display_Time_Y                 = 21

.var Display_Song_X                 = 26    // "Song: " (6 chars) → colon at col 30
.var Display_Song_Y                 = 21

.var Display_Separator3_Y           = 22

.var Display_Controls_Line1_X       = 3
.var Display_Controls_Line1_Y       = 23

.var Display_Controls_Line2_X       = 3
.var Display_Controls_Line2_Y       = 24

.const COLOR_RAM = $d800
.const ROW_WIDTH = 40

// =============================================================================
// INCLUDES
// =============================================================================

#define INCLUDE_SPACE_FASTFORWARD
#define INCLUDE_PLUS_MINUS_SONGCHANGE
#define INCLUDE_09ALPHA_SONGCHANGE
#define INCLUDE_F1_SHOWRASTERTIMINGBAR
#define INCLUDE_TIMER

// Raster line for music call 0; the remaining calls are CIA-timer driven and
// may be interrupted by the charset split IRQ (see INC/multicallirq.asm).
.const MUSIC_SYNC_LINE = 250

// Make the shared intro effect draw into this player's in-bank screen/charset
// instead of the fixed bank-0 $0400 screen.
#define BANK_AWARE_EFFECT

.import source "../INC/common.asm"
.import source "../INC/keyboard.asm"
.import source "../INC/musicplayback.asm"
.import source "../INC/multicallirq.asm"
.import source "../INC/linkedwitheffect.asm"

//; Graphics-donor build (-define GFX_DONOR): all runtime code is compiled
//; out - the full-bank bin only donates the data block + VIC assets to the
//; relocating exporter, so code size is never capped by the bank layout.
#if !GFX_DONOR


// =============================================================================
// INITIALIZATION
// =============================================================================

Initialize:

    sei

    lda #$35
    sta $01

    // Point the VIC at our bank and load the info charset before anything is
    // drawn, so the intro renders from in-bank RAM.
    jsr SetupVICBank
    jsr CopyInfoRomCharset
    lda #D018_VALUE
    sta $d018

    jsr RunLinkedWithEffect

    jsr InitKeyboard

    lda SongNumber
    sta CurrentSong

    lda #0
    sta TimerSeconds
    sta TimerMinutes
    sta FrameCounter
    sta ShowRasterBars

    lda ClockType
    beq !pal+
    lda #60
    jmp !store+
!pal:
    lda #50
!store:
    sta FramesPerSecond

    //; No screen clear here: every cell is repainted below - CopyLogoToScreen
    //; fills rows 0-8 and DrawStaticInfo fills rows 9-24 - so a preliminary
    //; wipe would just be overwritten.

    // Set border and background colors
    lda borderColor
    sta $d020
    lda backgroundColor
    sta $d021

    // PETSCII logos ship no charset - copy the requested ROM set into the
    // logo charset RAM (other modes had their graphics injected at export).
    // The logo always uses the in-bank D018_LOGO value.
    jsr CopyLogoRomCharset
    lda #D018_LOGO
    sta LogoD018Value + 1

    // Copy logo screen codes to screen RAM (rows 0-8)
    jsr CopyLogoToScreen

    // Copy logo color data to color RAM (rows 0-8)
    jsr CopyLogoColors

    // If a custom 1x1 font has been injected, copy it into VIC-bank-0 RAM at
    // $2000 and switch the info-area $d018 value over to it. Otherwise leave
    // the SplitIRQ defaults pointing at the lowercase ROM charset.
    jsr SetupCharset

    // Set initial D018 for logo area
    lda #D018_LOGO
    sta $d018

    jsr PopulateMetadata
    jsr DrawStaticInfo

    lda CurrentSong
    tax
    tay
    jsr SIDInit

    jsr NMIFix

    jsr InitMultiCallIRQ
    StartRasterEvents(MUSIC_SYNC_LINE, MusicFrameHandler)

    // Curtain sprites over the split seam (after the intro - it clears $d015).
    jsr SetupCurtainSprites

    // Enable the display with the full logo register set (mode-dependent
    // $d011/$d016, logo background + $d022-$d024) for the top of the frame.
    jsr ApplyLogoRegs

    cli

MainLoop:
    jsr CheckKeyboard

    lda FastForwardActive
    beq MainLoop

    // Fast-forward mode: call SIDPlay multiple times from main loop
    // IRQs continue firing normally, so D018 splits keep working
!ffFrameLoop:
    lda NumCallsPerFrame
    sta FFCallCounter

!ffCallLoop:
    jsr SIDPlay
    inc $d020
    dec FFCallCounter
    lda FFCallCounter
    bne !ffCallLoop-

    jsr CheckMusicLoop          // forced song loop tracks fast-forwarded frames too
    jsr UpdateTimer
    jsr UpdateDynamicInfo
    jsr CheckSpaceKey

    lda FastForwardActive
    bne !ffFrameLoop-

    // Fast-forward ended
    lda #$00
    sta $d020

    jmp MainLoop

// =============================================================================
// COPY LOGO DATA TO SCREEN AND COLOR RAM
// =============================================================================

CopyLogoToScreen:
    // Copy 360 bytes of screen codes from staging to SCREEN_RAM
    // We do this in two chunks: 256 + 104
    ldx #0
!loop1:
    lda LogoScreenData, x
    sta SCREEN_RAM, x
    inx
    bne !loop1-

    ldx #0
!loop2:
    lda LogoScreenData + 256, x
    sta SCREEN_RAM + 256, x
    inx
    cpx #(LOGO_CELLS - 256)
    bne !loop2-

    rts

CopyLogoColors:
    // Copy 360 bytes of color data from staging to $D800
    ldx #0
!loop1:
    lda LogoColorData, x
    sta COLOR_RAM, x
    inx
    bne !loop1-

    ldx #0
!loop2:
    lda LogoColorData + 256, x
    sta COLOR_RAM + 256, x
    inx
    cpx #(LOGO_CELLS - 256)
    bne !loop2-

    rts

// =============================================================================
// RUNTIME VARIABLES
// =============================================================================

TimerSeconds:     .byte $00
TimerMinutes:     .byte $00
FrameCounter:     .byte $00
FramesPerSecond:  .byte $32

TempStorage:      .byte $00
CursorX:          .byte $00
CursorY:          .byte $00

// =============================================================================
// POPULATE METADATA
// =============================================================================

PopulateMetadata:

    lda SIDInit+1
    sta InitAddress
    lda SIDInit+2
    sta InitAddress+1

    lda SIDPlay+1
    sta PlayAddress
    lda SIDPlay+2
    sta PlayAddress+1

    lda NumSongs
    bne !skip+
    lda #1
    sta NumSongs
!skip:

    rts

// =============================================================================
// DRAW STATIC INFO (rows 9-24, one item per line)
// =============================================================================

DrawStaticInfo:
    // Clear info area (rows 9-24 = 16 rows = 640 bytes)
    ldx #0
!loop:
    lda #$20
    sta SCREEN_RAM + (INFO_START_ROW * ROW_WIDTH), x
    sta SCREEN_RAM + (INFO_START_ROW * ROW_WIDTH) + 256, x
    lda #0
    sta COLOR_RAM + (INFO_START_ROW * ROW_WIDTH), x
    sta COLOR_RAM + (INFO_START_ROW * ROW_WIDTH) + 256, x
    inx
    bne !loop-
    ldx #0
!loop2:
    lda #$20
    sta SCREEN_RAM + (INFO_START_ROW * ROW_WIDTH) + 512, x
    lda #0
    sta COLOR_RAM + (INFO_START_ROW * ROW_WIDTH) + 512, x
    inx
    cpx #(TOTAL_ROWS - INFO_START_ROW) * ROW_WIDTH - 512
    bne !loop2-

    // Row 9: Title
    ldx #Display_Title_X
    ldy #Display_Title_Y
    jsr SetCursor
    lda #<SongName
    ldy #>SongName
    ldx #Display_Title_Colour
    jsr PrintString

    // Row 10: Artist
    ldx #Display_Artist_X
    ldy #Display_Artist_Y
    jsr SetCursor
    lda #<ArtistName
    ldy #>ArtistName
    ldx #Display_Artist_Colour
    jsr PrintString

    // Row 11: Copyright
    ldx #Display_Copyright_X
    ldy #Display_Copyright_Y
    jsr SetCursor
    lda #<CopyrightInfo
    ldy #>CopyrightInfo
    ldx #Display_Copyright_Colour
    jsr PrintString

    // Row 12: Separator
    ldx #0
    ldy #Display_Separator1_Y
    jsr DrawSeparator

    // Row 13: Memory
    ldx #Display_Memory_X
    ldy #Display_Memory_Y
    jsr SetCursor
    lda #<MemoryLabel
    ldy #>MemoryLabel
    ldx #Display_InfoTitles_Colour
    jsr PrintString
    ldx #Display_InfoValues_Colour
    lda #'$'
    jsr PrintChar
    lda LoadAddress+1
    jsr PrintHexByte
    lda LoadAddress
    jsr PrintHexByte
    lda #'-'
    jsr PrintChar
    lda #'$'
    jsr PrintChar
    lda EndAddress+1
    jsr PrintHexByte
    lda EndAddress
    jsr PrintHexByte

    // Row 14: Init
    ldx #Display_Init_X
    ldy #Display_Init_Y
    jsr SetCursor
    lda #<InitLabel
    ldy #>InitLabel
    ldx #Display_InfoTitles_Colour
    jsr PrintString
    ldx #Display_InfoValues_Colour
    lda #'$'
    jsr PrintChar
    lda InitAddress+1
    jsr PrintHexByte
    lda InitAddress
    jsr PrintHexByte

    // Row 15: Play
    ldx #Display_Play_X
    ldy #Display_Play_Y
    jsr SetCursor
    lda #<PlayLabel
    ldy #>PlayLabel
    ldx #Display_InfoTitles_Colour
    jsr PrintString
    ldx #Display_InfoValues_Colour
    lda #'$'
    jsr PrintChar
    lda PlayAddress+1
    jsr PrintHexByte
    lda PlayAddress
    jsr PrintHexByte

    // Row 16: ZP Usage
    ldx #Display_ZP_X
    ldy #Display_ZP_Y
    jsr SetCursor
    lda #<ZPLabel
    ldy #>ZPLabel
    ldx #Display_InfoTitles_Colour
    jsr PrintString
    ldx #Display_InfoValues_Colour
    lda #<ZPUsageData
    ldy #>ZPUsageData
    jsr PrintString

    // Row 17: Songs
    ldx #Display_Songs_X
    ldy #Display_Songs_Y
    jsr SetCursor
    lda #<SongsLabel
    ldy #>SongsLabel
    ldx #Display_InfoTitles_Colour
    jsr PrintString
    ldx #Display_InfoValues_Colour
    lda NumSongs
    jsr PrintTwoDigits_NoPreZeros

    // Row 18: Clock
    ldx #Display_Clock_X
    ldy #Display_Clock_Y
    jsr SetCursor
    lda #<ClockLabel
    ldy #>ClockLabel
    ldx #Display_InfoTitles_Colour
    jsr PrintString
    lda ClockType
    beq !pal+
    lda #<NTSCText
    ldy #>NTSCText
    jmp !printClock+
!pal:
    lda #<PALText
    ldy #>PALText
!printClock:
    ldx #Display_InfoValues_Colour
    jsr PrintString

    // Row 19: SID
    ldx #Display_SID_X
    ldy #Display_SID_Y
    jsr SetCursor
    lda #<SIDLabel
    ldy #>SIDLabel
    ldx #Display_InfoTitles_Colour
    jsr PrintString
    lda SIDModel
    beq !old+
    lda #<SID8580Text
    ldy #>SID8580Text
    jmp !printSID+
!old:
    lda #<SID6581Text
    ldy #>SID6581Text
!printSID:
    ldx #Display_InfoValues_Colour
    jsr PrintString

    // Row 20: Separator
    ldx #0
    ldy #Display_Separator2_Y
    jsr DrawSeparator

    // Row 21: Time (left) + Song (right, only if multi-song)
    ldx #Display_Time_X
    ldy #Display_Time_Y
    jsr SetCursor
    lda #<TimeLabel
    ldy #>TimeLabel
    ldx #Display_InfoTitles_Colour
    jsr PrintString

    lda NumSongs
    cmp #2
    bcc !skipSong+

    ldx #Display_Song_X
    ldy #Display_Song_Y
    jsr SetCursor
    lda #<CurrentSongLabel
    ldy #>CurrentSongLabel
    ldx #Display_InfoTitles_Colour
    jsr PrintString

!skipSong:
    // Row 22: Separator
    ldx #0
    ldy #Display_Separator3_Y
    jsr DrawSeparator

    // Rows 23-24: Controls
    jmp DrawControls

// =============================================================================
// DRAW SEPARATOR LINE
// =============================================================================

DrawSeparator:

    jsr SetCursor

    ldy #39
    ldx #Display_Separators_Colour
!loop:
    lda #$2d
    jsr PrintChar
    dey
    bpl !loop-
    rts

// =============================================================================
// DRAW CONTROLS
// =============================================================================

DrawControls:

    ldx #Display_Controls_Line1_X
    ldy #Display_Controls_Line1_Y
    jsr SetCursor
    lda #<ControlsLine1
    ldy #>ControlsLine1
    ldx #Display_ControlsInfo_Colour
    jsr PrintString

    lda NumSongs
    cmp #2
    bcc !done+

    ldx #Display_Controls_Line2_X
    ldy #Display_Controls_Line2_Y
    jsr SetCursor
    lda #<ControlsLine2
    ldy #>ControlsLine2
    ldx #Display_ControlsInfo_Colour
    jsr PrintString

!done:
    rts

// =============================================================================
// UPDATE DYNAMIC INFO
// =============================================================================

UpdateDynamicInfo:
    // Time value at col 16 (Display_Time_X=10 + "Time: "=6 chars)
    ldx #16
    ldy #Display_Time_Y
    jsr SetCursor

    ldx #Display_InfoValues_Colour
    lda TimerMinutes
    jsr PrintTwoDigits
    lda #':'
    jsr PrintChar
    lda TimerSeconds
    jsr PrintTwoDigits

    //; Song length "/MM:SS" right after the elapsed time, when a real length is known
    //; (single-song only; the exporter leaves bakedHasLength 0 otherwise). Dimmer
    //; colour so it reads as secondary to the running clock.
    lda bakedHasLength
    beq !noLength+
    ldx #$0b
    lda #'/'
    jsr PrintChar
    lda bakedLenMin
    jsr PrintTwoDigits
    lda #':'
    jsr PrintChar
    lda bakedLenSec
    jsr PrintTwoDigits
!noLength:

    lda NumSongs
    cmp #2
    bcc !skip+

    // Song value at col 32 (Display_Song_X=26 + "Song: "=6 chars)
    ldx #32
    ldy #Display_Song_Y
    jsr SetCursor

    ldx #Display_InfoValues_Colour
    lda CurrentSong
    clc
    adc #1
    jsr PrintTwoDigits
    lda #'/'
    jsr PrintChar
    lda NumSongs
    jsr PrintTwoDigits

!skip:
    rts

// =============================================================================
// TIMER UPDATE
// =============================================================================

UpdateTimer:
#if CODE_ONLY
    //; Frame-exact loop wrap (relocatable build; the length is only shown here).
    //; CheckLoopWrap snaps the clock back to the loop point the instant it reaches
    //; the loop end and sets carry so we skip the normal per-frame increment. It
    //; lives after the register-setup code (Main Code is packed against the logo
    //; staging at $0D00, with no room for the wrap inline).
    jsr CheckLoopWrap
    bcs !done+
#endif
    inc FrameCounter

    lda FrameCounter
    cmp FramesPerSecond
    bcc !done+

    lda #0
    sta FrameCounter

    inc TimerSeconds
    lda TimerSeconds
    cmp #60
    bcc !done+

    lda #0
    sta TimerSeconds
    inc TimerMinutes

    lda TimerMinutes
    cmp #100
    bcc !done+
    lda #99
    sta TimerMinutes
    lda #59
    sta TimerSeconds

!done:
    rts

// =============================================================================
// PRINT ROUTINES
// =============================================================================

ScreenLinePtrsLo:    .fill 25, <(SCREEN_RAM + (i * 40))
ScreenLinePtrsHi:    .fill 25, >(SCREEN_RAM + (i * 40))

SetCursor:

    txa
    clc
    adc ScreenLinePtrsLo, y
    sta PrintPtr + 1
    sta ColorPtr + 1

    lda ScreenLinePtrsHi, y
    adc #0
    sta PrintPtr + 2
    and #$03
    ora #$d8
    sta ColorPtr + 2

    rts

PrintString:
    sta StringReadPtr + 1
    sty StringReadPtr + 2

    ldy #0
!loop:
StringReadPtr:
    lda $abcd,y
    beq !done+

    jsr PrintChar

    iny
    cpy #32
    bne !loop-

!done:
    rts

PrintChar:

PrintPtr:
    sta $abcd

ColorPtr:
    stx $abcd

    inc PrintPtr + 1
    bne !skip+
    inc PrintPtr + 2
!skip:

    inc ColorPtr + 1
    bne !skip+
    inc ColorPtr + 2
!skip:

    rts

PrintHexByte:
    pha
    lsr
    lsr
    lsr
    lsr
    jsr PrintHexNibble
    pla
    and #$0f
    jmp PrintHexNibble

PrintHexNibble:
    cmp #10
    bcc !digit+
    clc
    adc #'A'-10
    jmp !print+
!digit:
    clc
    adc #'0'
!print:
    jmp PrintChar

TopDigit: .fill 100, (i / 10) + '0'
BottomDigit: .fill 100, mod(i, 10) + '0'

PrintTwoDigits:
    tay
    lda TopDigit, y
    jsr PrintChar

    lda BottomDigit, y
    jmp PrintChar

PrintTwoDigits_NoPreZeros:
    tay
    lda TopDigit, y
    cmp #$30
    beq !skip+
    jsr PrintChar
!skip:

    lda BottomDigit, y
    jmp PrintChar

// =============================================================================
// INTERRUPT HANDLERS (see INC/multicallirq.asm for the shared scheduler)
// Two raster events per frame: the frame call at MUSIC_SYNC_LINE (switches to
// the logo charset for the top of the next frame) and the charset split at the
// row 9 boundary. The split is an "urgent" event: it may interrupt a mid-frame
// music call, flip $d018 and return without affecting playback.
// =============================================================================

MusicFrameHandler:
    // Logo-area registers for the top of the next frame ($d018 + the
    // mode-dependent $d011/$d016/$d021-$d024). Runs in the bottom border,
    // so nothing here is cycle-critical.
    jsr ApplyLogoRegs

    // Armed on the curtain's first blocked line: the sprites hide both
    // lines, so the handler just writes the registers - any entry jitter
    // (even nesting into a music call) lands inside the blocked window.
    SetNextRasterEvent(CURTAIN_TOP_BLOCK_LINE, SplitIRQ)
    jmp MusicFrameCall

// SplitIRQ fires on the curtain's first blocked line and switches the VIC
// back to plain text mode on the info charset. The two blocked lines hide
// whatever renders while the registers change, so no spin or padding is
// needed - the info area takes over cleanly from the first unblocked line.
SplitIRQ:
    lda #$1b                    // text mode (clears BMM/ECM from bitmap/ECM logos)
    ldx backgroundColor
    // Info charset value (kept as a self-mod slot at InfoD018Value + 1)
InfoD018Value:
    ldy #D018_INFO
    sta $d011
    stx $d021
    sty $d018
    lda #$08                    // multicolour off for the info text
    sta $d016

    SetNextRasterEvent(MUSIC_SYNC_LINE, MusicFrameHandler)
    jmp ExitIRQ

MusicCall_Frame:
MusicCall_Other:
    jmp JustPlayMusic

FrameCall:
    jsr UpdateTimer
    jsr UpdateSeparatorAnimation
    jmp UpdateDynamicInfo

// =============================================================================
// TEXT DATA
// =============================================================================

MemoryLabel:        .text "Memory: "
                    .byte 0
InitLabel:          .text "Init: "
                    .byte 0
PlayLabel:          .text "Play: "
                    .byte 0
ZPLabel:            .text "ZP Usage: "
                    .byte 0
SongsLabel:         .text "Songs: "
                    .byte 0
ClockLabel:         .text "Clock: "
                    .byte 0
SIDLabel:           .text "SID: "
                    .byte 0
PALText:            .text "PAL"
                    .byte 0
NTSCText:           .text "NTSC"
                    .byte 0
SID6581Text:        .text "6581"
                    .byte 0
SID8580Text:        .text "8580"
                    .byte 0
TimeLabel:          .text "Time: "
                    .byte 0
CurrentSongLabel:   .text "Song: "
                    .byte 0

// Control labels
ControlsLine1:      .text "F1=Timing Bar  SPACE=Fast Fwd"
                    .byte 0
ControlsLine2:      .text "+/-=Next/Prev 1-9,A-Z=Select"
                    .byte 0

// =============================================================================
// VIC BANK SETUP
//
// Switch the VIC to VIC_BANK by writing the (inverted) bank bits into the low
// two bits of CIA2 $dd00, after making sure those lines are outputs in $dd02.
// =============================================================================

SetupVICBank:
    lda $dd02
    ora #$03
    sta $dd02
    lda $dd00
    and #$fc
    ora #(3 - VIC_BANK)
    sta $dd00
    rts

// =============================================================================
// CHARSET SETUP
//
// The character ROM is only reachable while I/O is banked out, so each copy
// flips $01 to $33 (with interrupts already disabled) and back to $35.
//
//   CopyInfoRomCharset : lowercase ROM ($D800) -> INFO_CHARSET_RAM
//   CopyLogoRomCharset : PETSCII logos only (modes 5/6): uppercase ($D000) or
//                        lowercase ($D800) ROM -> LOGO_CHARSET_RAM; the other
//                        modes had their graphics injected at export
//   SetupCharset       : overlay the injected custom font (fontMode != 0) on
//                        top of the info charset; ROM mode keeps the copy made
//                        by CopyInfoRomCharset.
// =============================================================================

CopyInfoRomCharset:
    lda #$33
    sta $01
    lda #$d8                    // lowercase ROM at $D800
    ldx #>INFO_CHARSET_RAM
    jsr Copy2K
    lda #$35
    sta $01
    rts

CopyLogoRomCharset:
    ldy logoMode
    cpy #LOGO_MODE_PETSCII_UPPER
    bcc !done+                  // modes 0-4: charset/bitmap injected at export
    lda #$33
    sta $01
    lda #$d0                    // mode 5: uppercase ROM ($D000)
    cpy #LOGO_MODE_PETSCII_LOWER
    bne !upper+
    lda #$d8                    // mode 6: lowercase ROM ($D800)
!upper:
    ldx #>LOGO_CHARSET_RAM
    jsr Copy2K
    lda #$35
    sta $01
!done:
    rts

// Copy 2K (8 pages) of page-aligned data. A = source high byte, X = dest high
// byte (both low bytes are $00). Self-modifying.
Copy2K:
    sta Copy2K_src + 2
    stx Copy2K_dst + 2
    ldy #8
!page:
    ldx #0
!byte:
Copy2K_src:
    //; .abs forces 3-byte absolute addressing. Without it KickAss shrinks a $0000
    //; operand to zero-page (lda $00,x = 2 bytes), and then Copy2K_src + 2 no longer
    //; addresses the operand's high byte - the self-modification writes into the next
    //; instruction and the loop reads/writes zero page. That crashes the player.
    lda.abs $0000, x
Copy2K_dst:
    sta.abs $0000, x
    inx
    bne !byte-
    inc Copy2K_src + 2
    inc Copy2K_dst + 2
    dey
    bne !page-
    rts

SetupCharset:
    lda fontMode
    beq !done+

    ldx #0
!loop:
    .for (var i = 0; i < 3; i++) {
        lda EmbeddedCharset + (i * 256), x
        sta INFO_CHARSET_RAM + (i * 256), x
    }
    inx
    bne !loop-
!done:
    rts

// =============================================================================
// LOGO DATA at fixed offsets (filled at build time by prg-builder.js)
// =============================================================================

* = LOAD_ADDRESS + $0D00 "Logo Screen Data"
LogoScreenData:
    .fill LOGO_CELLS, $20              // 360 bytes of screen codes (default: spaces)

* = LOAD_ADDRESS + $0E68 "Logo Color Data"
LogoColorData:
    .fill LOGO_CELLS, $00              // 360 bytes of color data (default: black)

// =============================================================================
// EMBEDDED CHARSET DATA (768 bytes; populated by prg-builder when not ROM mode)
// =============================================================================

* = LOAD_ADDRESS + $1000 "Embedded Charset"
EmbeddedCharset:
    .fill $300, $00

// =============================================================================
#endif // !GFX_DONOR (code)

// VIC GRAPHICS - the logo + info charset RAMs and the screen matrix, filled at
// runtime (ROM charset copies, logo staging, info text). These are the ONLY parts
// that must live in a 16 KB VIC bank. A CODE_ONLY build omits them - the exporter
// reserves the region in a free bank and the code, keyed to :gfxBank=, writes into
// it at runtime. The classic build emits them so its output is a self-contained bank
// image (and the reloc graphics source); graphicsBase is the logo charset ($2000).
// =============================================================================

#if !CODE_ONLY
* = LOGO_CHARSET_RAM "Logo Graphics RAM"
    .fill LOGO_GFX_SIZE, $00           // charset (first $800) or bitmap rows 0-8
* = CURTAIN_SPRITE_DATA "Curtain Sprite"
    .fill 57, $00                      // rows 0-18 transparent
    .fill 6, $ff                       // rows 19-20 solid - the 2-line block
    .byte $00
* = SCREEN_RAM "Screen RAM"
    .fill $400, $00
* = INFO_CHARSET_RAM "Info Charset RAM"
    .fill $800, $00
#endif

// =============================================================================
// SEPARATOR "BOUNCING BALL" ANIMATION
// The main code runs right up to the fixed logo-data region at LOAD+$0D00, so
// this parks in the free RAM after the embedded charset (below the VIC
// graphics) and stays part of the relocatable code blob in a CODE_ONLY build.
// =============================================================================

.var SEPANIM_ADDRESS = LOAD_ADDRESS + $1300
.import source "../INC/separatoranim.asm"

// =============================================================================
// LOGO REGISTER SETUP
// Applies the logo area's VIC registers for the top of the frame: $d018 (one
// value fits every mode - see the .errorif above), $d011/$d016 looked up by
// the logo mode byte, the logo background, and $d022-$d024 (contiguous at
// data block $71-$73; zero for modes that ignore them). Parked after the
// separator animation because Main Code is packed against the logo staging.
// =============================================================================

#if !GFX_DONOR // (code after the VIC assets)
* = LOAD_ADDRESS + $1400 "Logo Register Setup"

ApplyLogoRegs:
LogoD018Value:
    lda #D018_LOGO              // Self-modified at init (kept for symmetry)
    sta $d018
    ldx logoMode
    lda LogoD011Table, x
    sta $d011
    lda LogoD016Table, x
    sta $d016
    lda logoBackground
    sta $d021
    ldx #$02
!regs:
    lda LogoD022, x
    sta $d022, x
    dex
    bpl !regs-
    rts

// $d011/$d016 by logo mode: 0=MC bitmap, 1=hires bitmap, 2=hires text,
// 3=MC/mixed text, 4=ECM, 5/6=PETSCII (plain hires text on the ROM copy).
LogoD011Table: .byte $3b, $3b, $1b, $1b, $5b, $1b, $1b
LogoD016Table: .byte $18, $08, $08, $18, $08, $08, $08

// 7 x-expanded border-coloured sprites across the full width, hiding the
// split's two seam lines behind their last two rows (see SPRITE CURTAIN).
SetupCurtainSprites:
    ldx #$06
    ldy #$0c                    // sprite 6 first: $d00c/$d00d, then down to $d000/$d001
!loop:
    lda CurtainXTable, x
    sta $d000, y
    lda #CURTAIN_SPRITE_Y
    sta $d001, y
    lda borderColor
    sta $d027, x
    lda #CURTAIN_SPRITE_PTR
    sta SCREEN_RAM + $3F8, x
    dey
    dey
    dex
    bpl !loop-
    lda #$60                    // sprites 5 (264) and 6 (312) sit past the 256-line: MSBs set
    sta $d010
    lda #$7f
    sta $d01d                   // x-expand all 7 (sprite 7 unused)
    lda #$00
    sta $d017                   // no y-expand
    sta $d01c                   // hires sprites
    sta $d01b                   // in front of the graphics
    lda #$7f
    sta $d015                   // curtain on
    rts

CurtainXTable: .byte 24, 72, 120, 168, 216, 264 - 256, 312 - 256

// =============================================================================
// FRAME-EXACT LOOP WRAP (CODE_ONLY)
// The elapsed clock carries an exact frame position as MM:SS:frame (FrameCounter
// is the sub-second frame). When that triple reaches the baked loop END, snap the
// whole clock back to the loop START triple and set carry so UpdateTimer skips its
// per-frame increment. Comparing/resetting the frame counter itself keeps the wrap
// frame-exact with no cumulative drift. Parked here (not inline) because Main Code
// is packed against the logo staging at $0D00; there is 3 KB free below $2000.
// =============================================================================

#if CODE_ONLY
CheckLoopWrap:
    lda bakedHasLength
    beq !nowrap+
    lda FrameCounter
    cmp bakedLoopEndFrameRem
    bne !nowrap+
    lda TimerSeconds
    cmp bakedLoopEndSec
    bne !nowrap+
    lda TimerMinutes
    cmp bakedLoopEndMin
    bne !nowrap+
    //; Reached the loop end - snap the clock back to the loop point.
    lda bakedLoopFrameRem
    sta FrameCounter
    lda bakedLoopSec
    sta TimerSeconds
    lda bakedLoopMin
    sta TimerMinutes
    sec                         //; wrapped - caller skips the increment
    rts
!nowrap:
    clc
    rts
#endif

// =============================================================================
// END OF FILE
// =============================================================================

#endif // !GFX_DONOR (tail code)
