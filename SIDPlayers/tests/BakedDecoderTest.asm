//; =============================================================================
//; BakedDecoderTest.asm - assembles the baked spectrometer decoder on its own so
//; scripts/test-baked-decoder.js can run it in the 6510 emulator and diff its
//; output against the JavaScript baker's reconstruct().
//;
//; The decoder is the one piece of the player where the C64 and the exporter
//; have to agree byte-for-byte on a data layout, and it is self-modifying, so a
//; layout change is easy to get subtly wrong and impossible to eyeball. This
//; harness pins both sides to the same answer.
//;
//; Build:  java -jar KickAss.jar SIDPlayers/tests/BakedDecoderTest.asm \
//;                 -define SPECTROMETER_BAKED -binfile -o <out>.bin
//; The .bin loads at $0800. Fixed entry points (see the runner):
//;   $0800  jmp InitBaked          - operand = InitBaked's real address
//;   $0803  jmp TickBakedFrame     - operand = TickBakedFrame's real address
//;   $0806  .word targetBarHeights - the column on show after each tick
//;   $0808  .word bakedJustLooped  - set to 1 on the frame the last keyframe shows
//;   $080A.. the config block the exporter patches (same order as the players)
//; =============================================================================

//; Constants the spectrometer module expects from its host player. These match
//; RaistlinBars - the widest baked player, and the geometry the baker defaults to.
.const NUM_FREQUENCY_BARS   = 40
.const TOP_SPECTRUM_HEIGHT  = 14
.const MAX_BAR_HEIGHT       = TOP_SPECTRUM_HEIGHT * 8 - 1
.const BAR_INCREASE_RATE    = 1
.const BAR_DECREASE_RATE    = 1

* = $0800 "test entry"

    jmp InitBaked                       //; $0800
    jmp TickBakedFrame                  //; $0803
    .word targetBarHeights              //; $0806
    .word bakedJustLooped               //; $0808

//; Config block, patched by the runner exactly as prg-builder.js patches a real
//; player's header. Keep the order in step with the players' header layout.
bakedCodebookPtr:   .word $0000         //; $080A
bakedIndexStart:    .word $0000         //; $080C
bakedNumKeyframes:  .word $0000         //; $080E
bakedLoopStart:     .word $0000         //; $0810
bakedNumSegments:   .byte $00           //; $0812
bakedSegWidth:      .byte $00           //; $0813
bakedFrameDivisor:  .byte $00           //; $0814

#import "../INC/spectrometer.asm"
