// =============================================================================
//                               DEFAULT
//                         Text Details Player
// =============================================================================

.var LOAD_ADDRESS                   = cmdLineVars.get("loadAddress").asNumber()
.var CODE_ADDRESS                   = cmdLineVars.get("sysAddress").asNumber()
.var DATA_ADDRESS                   = cmdLineVars.get("dataAddress").asNumber()

* = DATA_ADDRESS "Data Block"
    .fill $71, $00
fontMode:
    .byte $00                   // $71: 0 = C64 ROM charset, 1 = injected RAM charset
bakedLenMin:
    .byte $00                   // $72: song length MM (patched at export; only when known)
bakedLenSec:
    .byte $00                   // $73: song length SS
bakedHasLength:
    .byte $00                   // $74: 1 when a real (single-song) length is known
    //; Frame-exact loop wrap: the elapsed clock already tracks an exact frame
    //; position as MM:SS:frame (FrameCounter is the sub-second frame). The instant
    //; it reaches the loop END triple it snaps back to the loop START triple - so
    //; it never runs past the length, and the reset is frame-exact (no drift).
bakedLoopMin:
    .byte $00                   // $75: loop-start MM (reset target)
bakedLoopSec:
    .byte $00                   // $76: loop-start SS
bakedLoopFrameRem:
    .byte $00                   // $77: loop-start frame within that second
bakedLoopEndMin:
    .byte $00                   // $78: loop-end MM (wrap trigger)
bakedLoopEndSec:
    .byte $00                   // $79: loop-end SS
bakedLoopEndFrameRem:
    .byte $00                   // $7A: loop-end frame within that second
    .fill $100 - $7B, $00

* = CODE_ADDRESS "Main Code"

#if !GFX_DONOR
    jmp Initialize
#endif

// =============================================================================
// VIC BANK / SCREEN / CHARSET LAYOUT
//
// The player runs from whichever VIC bank its code was assembled into
// (LOAD_ADDRESS / $4000). Keeping the screen and charset inside that bank
// means a SID that loads as low as $0400 is never overwritten by the display.
//
//   Bank 0   : screen $0400,        charset RAM $2000        (classic low map)
//   Bank 1-3 : screen <bank>+$2000, charset RAM <bank>+$2800
//
// The charset always lives in RAM: the C64 character ROM is only VIC-visible
// in banks 0 and 2, so banks 1 and 3 must have a copy. At init we copy the
// lowercase character ROM into CHARSET_RAM; a custom font, if injected,
// overwrites it after the intro.
// =============================================================================

// The VIC bank is decoupled from the code load address so a CODE_ONLY build can
// relocate the code to any free page while the screen + charset RAM (the only thing
// that must live in a 16 KB VIC bank) is placed in its own bank by the exporter. The
// classic single-blob build derives the bank from the load address (output
// unchanged); CODE_ONLY takes an optional :gfxBank= so the reloc tooling can shift the
// graphics bank independently of the code page.
#if CODE_ONLY
.var VIC_BANK           = cmdLineVars.containsKey("gfxBank") ? cmdLineVars.get("gfxBank").asNumber() : 1
#else
.var VIC_BANK           = floor(LOAD_ADDRESS / $4000)
#endif
.var VIC_BANK_ADDRESS   = VIC_BANK * $4000

.var SCREEN_RAM         = VIC_BANK_ADDRESS + $2000
.var CHARSET_RAM        = VIC_BANK_ADDRESS + $2800
.var ScreenD018Nibble   = 8     // $2000 / $400
.var CharsetD018Nibble  = 5     // $2800 / $800
.if (VIC_BANK == 0) {
    .eval SCREEN_RAM        = $0400
    .eval CHARSET_RAM       = $2000
    .eval ScreenD018Nibble  = 1     // $0400 / $400
    .eval CharsetD018Nibble = 4     // $2000 / $800
}
.var D018_VALUE         = (ScreenD018Nibble * 16) + (CharsetD018Nibble * 2)

.var Display_Title_Colour           = $01
.var Display_Artist_Colour          = $0c
.var Display_Copyright_Colour       = $0c
.var Display_Separators_Colour      = $0b
.var Display_InfoTitles_Colour      = $0e
.var Display_InfoValues_Colour      = $01
.var Display_ControlsTitle_Colour   = $02
.var Display_ControlsInfo_Colour    = $04

.var Display_Title_X                = 4    
.var Display_Title_Y                = 0

.var Display_Artist_X               = 4
.var Display_Artist_Y               = 1

.var Display_Copyright_X            = 4
.var Display_Copyright_Y            = 2

.var Display_Separator1_Y           = 5

.var Display_Memory_X               = 9 + 2
.var Display_Memory_Y               = 6

.var Display_InitLabel_X            = 9 + 4
.var Display_InitLabel_Y            = 7

.var Display_PlayLabel_X            = 9 + 4
.var Display_PlayLabel_Y            = 8

.var Display_ZP_X                   = 9 + 0
.var Display_ZP_Y                   = 9
.var Display_Songs_X                = 9 + 3
.var Display_Songs_Y                = 10
.var Display_Clock_X                = 9 + 3
.var Display_Clock_Y                = 11
.var Display_SID_X                  = 9 + 5
.var Display_SID_Y                  = 12

.var Display_Separator2_Y           = 13

.var Display_Time_X                 = 9 + 4
.var Display_Time_Y                 = 14
.var Display_Song_X                 = 9 + 4
.var Display_Song_Y                 = 15

.var Display_Separator3_Y           = 16

.var Display_ControlsTitle_X        = 13
.var Display_ControlsTitle_Y        = 19
.var Display_Controls_F1_X          = 8
.var Display_Controls_F1_Y          = 21
.var Display_Controls_SPACE_X       = 6
.var Display_Controls_SPACE_Y       = 22
.var Display_Controls_Navigation_X  = 8
.var Display_Controls_Navigation_Y  = 23
.var Display_Controls_SongSelectKeys_X = 8
.var Display_Controls_SongSelectKeys_Y = 24

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

// Raster line for music call 0; the remaining calls are CIA-timer driven
// (see INC/multicallirq.asm).
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
// INITIALIZATION ENTRY POINT
// =============================================================================

Initialize:

    sei

    lda #$35
    sta $01

    // Point the VIC at our bank and load the charset before anything is drawn,
    // so the intro and the main display both render from in-bank RAM.
    jsr SetupVICBank
    jsr CopyRomCharset
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

    //; No screen clear here: DrawStaticInfo below repaints all 25 rows (screen
    //; + colour RAM), so a preliminary wipe would just be overwritten.
    lda #$00
    sta $d020
    sta $d021

    jsr SetupCharset

    jsr PopulateMetadata

    jsr DrawStaticInfo
    
    lda CurrentSong
    tax
    tay
    jsr SIDInit

    jsr NMIFix

    jsr InitMultiCallIRQ
    StartRasterEvents(MUSIC_SYNC_LINE, MusicFrameHandler)

    lda #$1b
    sta $d011

    cli

MainLoop:
    jsr CheckKeyboard

    lda FastForwardActive
    beq MainLoop

    // Fast-forward mode: call SIDPlay multiple times from main loop.
    // The IRQ framework skips its own play calls while this is active.
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

    lda #$00
    sta $d020

    jmp MainLoop

// =============================================================================
// RUNTIME VARIABLES
// =============================================================================

TimerSeconds:     .byte $00
TimerMinutes:     .byte $00
FrameCounter:     .byte $00
FramesPerSecond:  .byte $32

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
// DRAW STATIC INFORMATION
// =============================================================================

DrawStaticInfo:
    ldx #0
!loop:
    lda #$20
    sta SCREEN_RAM,x
    sta SCREEN_RAM+256,x
    sta SCREEN_RAM+512,x
    sta SCREEN_RAM+768,x
    lda #0
    sta COLOR_RAM,x
    sta COLOR_RAM+256,x
    sta COLOR_RAM+512,x
    sta COLOR_RAM+768,x
    inx
    bne !loop-

    ldx #Display_Title_X
    ldy #Display_Title_Y
    jsr SetCursor
    lda #<SongName
    ldy #>SongName
    ldx #Display_Title_Colour
    jsr PrintString

    ldx #Display_Artist_X
    ldy #Display_Artist_Y
    jsr SetCursor
    lda #<ArtistName
    ldy #>ArtistName
    ldx #Display_Artist_Colour
    jsr PrintString

    ldx #Display_Copyright_X
    ldy #Display_Copyright_Y
    jsr SetCursor
    lda #<CopyrightInfo
    ldy #>CopyrightInfo
    ldx #Display_Copyright_Colour
    jsr PrintString

    ldx #0
    ldy #Display_Separator1_Y
    jsr DrawSeparator

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

    ldx #Display_InitLabel_X
    ldy #Display_InitLabel_Y
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

    ldx #Display_PlayLabel_X
    ldy #Display_PlayLabel_Y
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
    jmp !print+
!pal:
    lda #<PALText
    ldy #>PALText
!print:
    ldx #Display_InfoValues_Colour
    jsr PrintString

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
    jmp !print+
!old:
    lda #<SID6581Text
    ldy #>SID6581Text
!print:
    ldx #Display_InfoValues_Colour
    jsr PrintString

    ldx #0
    ldy #Display_Separator2_Y
    jsr DrawSeparator

    ldx #Display_Time_X
    ldy #Display_Time_Y
    jsr SetCursor
    lda #<TimeLabel
    ldy #>TimeLabel
    ldx #Display_InfoTitles_Colour
    jsr PrintString

    lda NumSongs
    cmp #2
    bcc !skip+
    
    ldx #Display_Song_X
    ldy #Display_Song_Y
    jsr SetCursor
    lda #<CurrentSongLabel
    ldy #>CurrentSongLabel
    ldx #Display_InfoTitles_Colour
    jsr PrintString

!skip:
    ldx #0
    ldy #Display_Separator3_Y
    jsr DrawSeparator

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
    
    ldx #Display_ControlsTitle_X
    ldy #Display_ControlsTitle_Y
    jsr SetCursor
    lda #<ControlsLabel
    ldy #>ControlsLabel
    ldx #Display_ControlsTitle_Colour
    jsr PrintString

    ldx #Display_Controls_F1_X
    ldy #Display_Controls_F1_Y
    jsr SetCursor
    lda #<F1Text
    ldy #>F1Text
    ldx #Display_ControlsInfo_Colour
    jsr PrintString

    ldx #Display_Controls_SPACE_X
    ldy #Display_Controls_SPACE_Y
    jsr SetCursor
    lda #<SpaceText
    ldy #>SpaceText
    ldx #Display_ControlsInfo_Colour
    jsr PrintString
    
    lda NumSongs
    cmp #2
    bcs !multipleSongs+
    rts

!multipleSongs:
    ldx #Display_Controls_SongSelectKeys_X
    ldy #Display_Controls_SongSelectKeys_Y
    jsr SetCursor
    
    lda NumSongs
    cmp #10
    bcc !under10+
    
    lda #<Select19Text
    ldy #>Select19Text
    ldx #Display_ControlsInfo_Colour
    jsr PrintString
    
    lda NumSongs
    cmp #10
    beq !nav+
    
    lda #<CommaSpace
    ldy #>CommaSpace
    ldx #Display_ControlsInfo_Colour
    jsr PrintString
    
    lda #<AThru
    ldy #>AThru
    ldx #Display_ControlsInfo_Colour
    jsr PrintString
    
    lda NumSongs
    sec
    sbc #9
    cmp #27
    bcc !letter+
    lda #26
!letter:
    clc
    adc #'A'-1
    jsr PrintChar
    
    jmp !nav+

!under10:
    lda #<OneThru
    ldy #>OneThru
    ldx #Display_ControlsInfo_Colour
    jsr PrintString
    
    lda NumSongs
    clc
    adc #'0'
    jsr PrintChar
    
    lda #<SelectSuffix
    ldy #>SelectSuffix
    ldx #Display_ControlsInfo_Colour
    jsr PrintString

!nav:
    ldx #Display_Controls_Navigation_X
    ldy #Display_Controls_Navigation_Y
    jsr SetCursor
    lda #<NavigationText
    ldy #>NavigationText
    ldx #Display_ControlsInfo_Colour
    jmp PrintString

// =============================================================================
// UPDATE DYNAMIC INFO
// =============================================================================

UpdateDynamicInfo:
    ldx #Display_Time_X + 6
    ldy #Display_Time_Y
    jsr SetCursor
    
    ldx #Display_InfoValues_Colour
    lda TimerMinutes
    jsr PrintTwoDigits
    lda #':'
    jsr PrintChar
    lda TimerSeconds
    jsr PrintTwoDigits

#if CODE_ONLY
    //; Song length "/MM:SS" right after the elapsed time when a real length is known
    //; (single-song only; the exporter leaves bakedHasLength 0 otherwise). Dimmer
    //; colour so it reads as secondary to the clock. CODE_ONLY only: the relocatable
    //; code blob has the room, the fixed-bank fallback stays byte-for-byte as it was.
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
#endif

    lda NumSongs
    cmp #2
    bcc !skip+

    ldx #Display_Song_X + 6
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
    //; The elapsed clock already carries an exact frame position as MM:SS:frame
    //; (FrameCounter is the sub-second frame). When a loop is known, the instant
    //; that triple reaches the loop-end triple, snap it back to the loop-start
    //; triple instead of running past the length. The comparison and reset are on
    //; the frame counter itself, so there is no cumulative drift.
    lda bakedHasLength
    beq !plain+
    lda FrameCounter
    cmp bakedLoopEndFrameRem
    bne !plain+
    lda TimerSeconds
    cmp bakedLoopEndSec
    bne !plain+
    lda TimerMinutes
    cmp bakedLoopEndMin
    bne !plain+
    //; Reached the loop end - snap the whole clock back to the loop point.
    lda bakedLoopFrameRem
    sta FrameCounter
    lda bakedLoopSec
    sta TimerSeconds
    lda bakedLoopMin
    sta TimerMinutes
    rts
!plain:
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
// =============================================================================

// Music call 0, raster-driven once per frame. No display splits here, so the
// next raster event is simply this handler again next frame.
MusicFrameHandler:
    SetNextRasterEvent(MUSIC_SYNC_LINE, MusicFrameHandler)
    jmp MusicFrameCall

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
ControlsLabel:      .text "== CONTROLS =="
                    .byte 0

Select19Text:       .text "1-9"
                    .byte 0
OneThru:            .text "1-"
                    .byte 0
AThru:              .text "A-"
                    .byte 0
CommaSpace:         .text ", "
                    .byte 0
SelectSuffix:       .text " = Select Song"
                    .byte 0
NavigationText:     .text "+/- = Next/Prev Song"
                    .byte 0
F1Text:             .text " F1 = Toggle Timing Bar(s)"
                    .byte 0

SpaceText:          .text "SPACE = Fast Forward (Hold)"
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
// CopyRomCharset copies the 2K lowercase character ROM into CHARSET_RAM so the
// intro and (in ROM mode) the main display have a charset inside our VIC bank.
// The character ROM is only reachable while I/O is banked out, so we flip $01
// to $33 across the copy with interrupts already disabled.
//
// SetupCharset then overlays the injected custom font (fontMode != 0) on top of
// the ROM copy; in ROM mode it does nothing because $d018 already points at the
// CHARSET_RAM copy made above.
// =============================================================================

CopyRomCharset:
    lda #$33                    // CHAREN=0: character ROM visible at $D000-$DFFF
    sta $01
    ldx #0
!loop:
    .for (var i = 0; i < 8; i++) {
        lda $d800 + (i * 256), x
        sta CHARSET_RAM + (i * 256), x
    }
    inx
    bne !loop-
    lda #$35
    sta $01
    rts

SetupCharset:
    lda fontMode
    beq !done+

    ldx #0
!loop:
    .for (var i = 0; i < 3; i++) {
        lda EmbeddedCharset + (i * 256), x
        sta CHARSET_RAM + (i * 256), x
    }
    inx
    bne !loop-
!done:
    rts

// =============================================================================
// EMBEDDED CHARSET DATA (768 bytes; populated by prg-builder when not ROM mode)
// =============================================================================

//; Font source (copied into CHARSET_RAM at runtime by SetupCharset). It lives in the
//; CODE blob - the CPU reads it, the VIC never does - so it relocates with the code.
//; One page later than the classic $0D00 so the code (which grows a little in a
//; CODE_ONLY build to draw the song length) has headroom below it; the config's
//; charsetAddress tracks this offset, and the exporter injects a custom font there.
* = LOAD_ADDRESS + $0E00 "Embedded Charset"
EmbeddedCharset:
    .fill $300, $00

#endif // !GFX_DONOR (code)

//; VIC graphics: the screen matrix and the charset RAM the code fills at runtime.
//; These are the ONLY parts that must live in a 16 KB VIC bank. A CODE_ONLY build
//; omits them - the exporter reserves the region in a free bank and the code, keyed
//; to :gfxBank=, writes into it at runtime. The classic build emits them here so the
//; single-blob output is a self-contained bank image (and the reloc graphics source).
#if !CODE_ONLY
* = SCREEN_RAM "Screen RAM"
    .fill $400, $00
* = CHARSET_RAM "Charset RAM"
    .fill $800, $00
#endif

// =============================================================================
// SEPARATOR "BOUNCING BALL" ANIMATION
// Assembled into free RAM after the embedded charset (below the VIC graphics),
// so it stays part of the relocatable code blob in a CODE_ONLY build.
// =============================================================================

.var SEPANIM_ADDRESS = LOAD_ADDRESS + $1300
.import source "../INC/separatoranim.asm"
