//; =============================================================================
//;                              SIMPLE RASTER PLAYER
//;                        Basic SID Music Player for C64
//; =============================================================================
//;
//; Minimal raster-IRQ-driven SID player. Distributes multi-speed play calls
//; across the frame and flashes the border during SIDPlay so CPU usage is
//; visible. Background color updates once per frame as a beat indicator.
//;
//; =============================================================================

.var LOAD_ADDRESS                   = cmdLineVars.get("loadAddress").asNumber()
.var CODE_ADDRESS                   = cmdLineVars.get("sysAddress").asNumber()
.var DATA_ADDRESS                   = cmdLineVars.get("dataAddress").asNumber()

* = DATA_ADDRESS "Data Block"
    .fill $100, $00
    
* = CODE_ADDRESS "Main Code"

    jmp Initialize

//; =============================================================================
//; INCLUDES
//; =============================================================================

#define INCLUDE_SPACE_FASTFORWARD
#define INCLUDE_PLUS_MINUS_SONGCHANGE
#define INCLUDE_09ALPHA_SONGCHANGE

//; Raster line for music call 0; the remaining calls are CIA-timer driven
//; (see INC/multicallirq.asm).
.const MUSIC_SYNC_LINE = 250

.import source "../INC/common.asm"
.import source "../INC/keyboard.asm"
.import source "../INC/musicplayback.asm"
.import source "../INC/multicallirq.asm"
.import source "../INC/linkedwitheffect.asm"

//; =============================================================================
//; INITIALIZATION ENTRY POINT
//; =============================================================================

Initialize:
    sei

    lda #$35
    sta $01

    jsr RunLinkedWithEffect

    jsr InitKeyboard

    lda SongNumber
    sta CurrentSong
    
    lda NumSongs
    bne !skip+
    lda #1
    sta NumSongs
!skip:

    lda CurrentSong
    tax
    tay
    jsr SIDInit

    jsr VSync

    jsr NMIFix

    jsr InitMultiCallIRQ
    StartRasterEvents(MUSIC_SYNC_LINE, MusicFrameHandler)

    cli

Forever:
    jsr CheckKeyboard

    lda FastForwardActive
    beq Forever

    //; Fast-forward mode: call SIDPlay multiple times from main loop.
    //; The IRQ framework skips its own play calls while this is active.
!ffFrameLoop:
    lda NumCallsPerFrame
    sta FFCallCounter

!ffCallLoop:
    jsr SIDPlay
    inc $d020  // Visual feedback
    dec FFCallCounter
    lda FFCallCounter
    bne !ffCallLoop-

    jsr CheckMusicLoop          // forced song loop tracks fast-forwarded frames too

    // Check if space is still held
    jsr CheckSpaceKey
    lda FastForwardActive
    bne !ffFrameLoop-

    lda #$00
    sta $d020

    jmp Forever

//; =============================================================================
//; INTERRUPT HANDLERS (see INC/multicallirq.asm for the shared scheduler)
//; =============================================================================

MusicFrameHandler:
    SetNextRasterEvent(MUSIC_SYNC_LINE, MusicFrameHandler)
    jmp MusicFrameCall

//; Every play call flashes the border so CPU usage is visible.
MusicCall_Frame:
MusicCall_Other:
    inc $d020
    jsr SIDPlay
    dec $d020
    rts

//; Once per frame: slow background beat indicator.
FrameCall:
ColChangeFrame:
    ldy #$c0
    iny
    bne !skip+
    inc $d020
    ldy #$c0
!skip:
    sty ColChangeFrame + 1
    rts

//; =============================================================================
//; END OF FILE
//; =============================================================================
