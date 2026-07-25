// =============================================================================
//                      SEPARATOR "BOUNCING BALL" ANIMATION
//          A small idle animation for the text-details players
// =============================================================================
//
// While the music plays, a little "o" bounces left/right along the three
// dashed separator lines, dragging a fading colour comet-tail behind it. It
// keeps the otherwise static info screen alive without touching the music.
//
// The three separator rows are pure dashes, so the routine owns them
// completely: every frame it repaints all 40 columns of each line. A single
// ball position drives all three lines in sync, so one 40-byte "heat" buffer
// describes the trail for all of them.
//
// PLAYER CONTRACT
//   The importing player must, before importing this file, define:
//     SCREEN_RAM, COLOR_RAM, ROW_WIDTH      (screen layout)
//     Display_Separator1_Y / 2_Y / 3_Y      (the three separator rows)
//     SEPANIM_ADDRESS                       (where to assemble this segment)
//   and call UpdateSeparatorAnimation once per frame from FrameCall.
//
// The routine + its state get their own segment (SEPANIM_ADDRESS) rather than
// sitting inline in the main code: DefaultWithLogo's main code runs right up
// against the fixed logo-data region at LOAD+$0D00, so this parks in the free
// RAM between the embedded charset and the VIC graphics - still below the
// relocSplit, so a CODE_ONLY build relocates it as part of the code blob.
// =============================================================================

#importonce

// Graphics-donor builds (-define GFX_DONOR) carry no code: the full-bank
// bins only donate the VIC assets to the relocating exporter.
#if !GFX_DONOR

* = SEPANIM_ADDRESS "Separator Animation"

.var SepAnim_Line1Scr = SCREEN_RAM + Display_Separator1_Y * ROW_WIDTH
.var SepAnim_Line2Scr = SCREEN_RAM + Display_Separator2_Y * ROW_WIDTH
.var SepAnim_Line3Scr = SCREEN_RAM + Display_Separator3_Y * ROW_WIDTH
.var SepAnim_Line1Col = COLOR_RAM  + Display_Separator1_Y * ROW_WIDTH
.var SepAnim_Line2Col = COLOR_RAM  + Display_Separator2_Y * ROW_WIDTH
.var SepAnim_Line3Col = COLOR_RAM  + Display_Separator3_Y * ROW_WIDTH

.const SEPANIM_HEAT_MAX  = 8        // trail length in cells / ball's heat value
.const SEPANIM_BALL_CHAR = $0f      // lowercase 'o' screen code (the ball)
.const SEPANIM_DASH_CHAR = $2d      // '-' screen code (the separator line)

// -----------------------------------------------------------------------------
// UpdateSeparatorAnimation - advance one frame of the bouncing-ball trail.
// Call once per frame (from FrameCall). Clobbers A/X/Y.
// -----------------------------------------------------------------------------

UpdateSeparatorAnimation:

    // 1) Cool every cell by one step. After this the only cell still at
    //    SEPANIM_HEAT_MAX is whichever we set as the ball below, so the ball is
    //    unambiguously the hottest cell when we render.
    ldx #ROW_WIDTH - 1
!fade:
    lda SepAnim_Heat, x
    beq !skip+
    dec SepAnim_Heat, x
!skip:
    dex
    bpl !fade-

    // 2) Move the ball one column, bouncing off both ends of the line.
    lda SepAnim_BallX
    clc
    adc SepAnim_BallDir
    cmp #ROW_WIDTH
    bcc !inRange+               // 0..39 stays; 40 or $ff (from col 0) bounces
    lda SepAnim_BallDir
    eor #$fe                    // +1 <-> -1 ($01 xor $fe = $ff; $ff xor $fe = $01)
    sta SepAnim_BallDir
    clc
    adc SepAnim_BallX
!inRange:
    sta SepAnim_BallX

    // 3) The ball is the hottest cell.
    tax
    lda #SEPANIM_HEAT_MAX
    sta SepAnim_Heat, x

    // 4) Repaint all three separator lines from the shared heat buffer: colour
    //    from the ramp, char 'o' at the ball and '-' everywhere else.
    ldx #ROW_WIDTH - 1
!draw:
    ldy SepAnim_Heat, x
    lda SepAnim_ColourRamp, y
    sta SepAnim_Line1Col, x
    sta SepAnim_Line2Col, x
    sta SepAnim_Line3Col, x

    lda #SEPANIM_DASH_CHAR
    cpy #SEPANIM_HEAT_MAX
    bne !notBall+
    lda #SEPANIM_BALL_CHAR
!notBall:
    sta SepAnim_Line1Scr, x
    sta SepAnim_Line2Scr, x
    sta SepAnim_Line3Scr, x

    dex
    bpl !draw-
    rts

// -----------------------------------------------------------------------------
// State + data
// -----------------------------------------------------------------------------

SepAnim_BallX:   .byte 20               // start mid-line
SepAnim_BallDir: .byte 1                // +1 / -1 travel direction
SepAnim_Heat:    .fill ROW_WIDTH, 0     // per-column trail heat (0 = cold)

// Heat -> colour ramp (index 0..SEPANIM_HEAT_MAX). Cold end is the separator's
// own dark grey; the trail warms through blue/cyan up to a white ball head.
SepAnim_ColourRamp:
    .byte $0b, $0b, $06, $0e, $03, $03, $0f, $01, $01

#endif // !GFX_DONOR
