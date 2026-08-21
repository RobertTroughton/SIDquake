// charsetlab-core.js - CharSet Lab's PNG -> C64 charset analysis engine,
// extracted from charsetlab/charsetlab.js so the export pipeline can convert
// logo PNGs at export time (no pre-split .map/.scr/.col files needed).
//
// Input: RGBA pixels of a 320x200 image or a 384x272 VICE grab. The engine
// maps every pixel to a C64 palette index, optionally slides the 320x200
// screen window +/-7px to find the friendliest sub-character alignment, then
// tries the character modes in simplest-first order (PETSCII, Hires, Mixed/
// Multicolour, ECM) and reports every mode that fits.
//
// Output per fitted mode: charset bytes, screen RAM, colour RAM and the
// global colour registers ($d021-$d024 / $d022-$d023). buildLogoBlob() packs
// a result into a fixed-layout blob that visualizer configs can slice into
// memory regions (see LOGO_BLOB below).
//
// Runs in the browser (window.CharsetLabCore) and in Node (module.exports)
// so the conversion can be regression-tested outside the browser.
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root && typeof root === 'object') root.CharsetLabCore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    // Embedded copy of CPPTool/C64_Palettes.txt (Name,$c0..$c15 in C64 colour
    // order: black, white, red, cyan, purple, green, blue, yellow, orange,
    // brown, light-red, dark-grey, grey, light-green, light-blue, light-grey).
    // Keep in sync with charsetlab/charsetlab.js.
    var PALETTE_FILE = '\n\
VICE3_6_Pepto_PAL,$000000,$ffffff,$68372b,$70a4b2,$6f3d86,$588d43,$352879,$b8c76f,$6f4f25,$433900,$9a6759,$444444,$6c6c6c,$9ad284,$6c5eb5,$959595\n\
VICE3_6_Pixcen,$000000,$ffffff,$894036,$7abfc7,$8a46ae,$68a941,$3e31a2,$d0dc71,$905f25,$5c4700,$bb776d,$555555,$808080,$acea88,$7c70da,$ababab\n\
UnknownPal01,$000000,$ffffff,$924a40,$84c5cc,$9351b6,$72b14b,$483aaa,$d5df7c,$99692d,$675200,$c18178,$606060,$8a8a8a,$b3ec91,$867ade,$b3b3b3\n\
VICE3_6_VICE_Internal,$000000,$ffffff,$b56148,$99e6f9,$c161c9,$79d570,$6049ed,$f7ff6c,$ba8620,$837000,$e79a84,$7a7a7a,$a8a8a8,$c0ffb9,$a28fff,$d2d2d2\n\
UnknownPal02,$000000,$ffffff,$6f4b46,$93b5b9,$79578c,$799a66,$403a74,$ced4a0,$7c6347,$504512,$a3817c,$555555,$808080,$bcdbab,$7e78ae,$ababab\n\
UnknownPal03,$000000,$ffffff,$bb6a51,$a9f3ff,$bf6efb,$98e551,$6953f5,$ffff7b,$c69232,$8d7900,$f5ab96,$818181,$b6b6b6,$dbff9e,$b19eff,$e0e0e0\n\
UnknownPal32,$000000,$ffffff,$67372d,$73a3b1,$6e3e83,$5b8d48,$362976,$b7c576,$6c4f2a,$423908,$98675b,$444444,$6c6c6c,$9dd28a,$6d5fb0,$959595\n\
VICE3_6_Ptoing,$000000,$ffffff,$8c3e34,$7abfc7,$8d47b3,$68a941,$3e31a2,$d0dc71,$905f25,$574200,$bb776d,$545454,$808080,$acea88,$7c70da,$ababab\n\
Lemon64,$000000,$ffffff,$8b3e42,$7cd3cd,$9746a0,$5cb254,$3c39a9,$e3e76e,$945731,$593c07,$cd777c,$505050,$838383,$aff8a6,$7f7df4,$bababa\n\
VICE3_6_Pepto_PAL_CRT,$000000,$ffffff,$9f5541,$93d9ec,$a45bc4,$7ac559,$5841bb,$eafd88,$a47631,$6e5d00,$d5907c,$6b6b6b,$9a9a9a,$c4ffa5,$9a86fa,$c7c7c7\n\
UnknownPal04,$000000,$ffffff,$a34742,$84e1e6,$875bb2,$89b55f,$253f9b,$ffffa5,$b56439,$7b4100,$e78a85,$5c5c5c,$939393,$e4ffb9,$738de8,$cbcbcb\n\
PIXCEN_Colodore,$000000,$ffffff,$813338,$75cec8,$8e3c97,$56ac4d,$2e2c9b,$edf171,$8e5029,$553800,$c46c71,$4a4a4a,$7b7b7b,$a9ff9f,$706deb,$b2b2b2\n\
UnknownPal05,$000000,$ffffff,$bd516c,$91f5dc,$b855f6,$77dc46,$3e51f0,$ffff5c,$c4792d,$8a6700,$f08fa6,$777777,$a5a5a5,$c3ff99,$8898ff,$d5d5d5\n\
UnknownPal06,$000000,$ffffff,$924a40,$84c5cc,$9351b6,$72b14b,$483aa4,$d5df7c,$99692d,$675201,$c08178,$606060,$8a8a8a,$b2ec91,$867ade,$aeaeae\n\
UnknownCCC,$000000,$ffffff,$bc5241,$8feffb,$b956eb,$7edb40,$553fe4,$ffff77,$c17b1d,$826300,$f49486,$727272,$a4a4a4,$cdff98,$9e8dff,$d5d5d5\n\
UnknownPal07,$000000,$ffffff,$682f20,$6ca9ba,$70358a,$53903a,$2d1f7d,$c0d069,$704a19,$3d3200,$a06454,$3e3e3e,$696969,$9cde82,$6959bf,$999999\n\
PETSCIIEditor-FromJmin,$000000,$ffffff,$813338,$75cec8,$8e3c97,$56ac4d,$2e2c9b,$edf171,$8e5029,$553800,$c46c71,$4a4a4a,$7b7b7b,$a9ff9f,$706deb,$b2b2b2\n\
UsedBySande,$000000,$ffffff,$b06154,$a1e6ee,$b268d6,$8ed161,$5746be,$f7ff99,$b7853e,$7e6a00,$e29f93,$7a7a7a,$a9a9a9,$d4ffb0,$badbad,$d4d4d4\n\
VICE3_7_1_PEPTO,$000000,$ffffff,$883c25,$7fc4d6,$8d42ac,$65ae43,$3e25a2,$d6e876,$8d5f13,$544300,$bf7b66,$525252,$848484,$b0f693,$8470e2,$b2b2b2\n\
VICE3_6_Deekay,$000000,$ffffff,$882000,$68d0a8,$a838a0,$50b818,$181090,$f0e858,$a04800,$472b1b,$c87870,$484848,$808080,$98ff98,$5090d0,$b8b8b8\n\
UnknownPal08,$000000,$ffffff,$7e352b,$6eb7c1,$7f3ba6,$5ca035,$332799,$cbd765,$85531c,$503c00,$b46b61,$4a4a4a,$757575,$a3e77c,$7064d6,$a3a3a3\n\
UnknownPal09,$000000,$ffffff,$c83535,$83f0dc,$cc59c6,$59cd36,$4137cd,$f7ee59,$d17f30,$915f33,$f99b97,$5b5b5b,$8e8e8e,$9dff9d,$75a1ec,$c1c1c1\n\
UnknownPal10,$000000,$ffffff,$bb6a51,$a9f3ff,$cd6fd4,$89e581,$6953f5,$ffff7b,$c69232,$8d7900,$f5ab96,$818181,$b6b6b6,$cdffc6,$b19eff,$e0e0e0\n\
VICE3_6_Pepto_PAL_Old,$000000,$ffffff,$58291d,$91c6d5,$915ca8,$588d43,$352879,$b8c76f,$916f43,$433900,$9a6759,$353535,$747474,$9ad284,$7466be,$b8b8b8\n\
VICE3_6_Colodore,$000000,$ffffff,$96282e,$5bd6ce,$9f2dad,$41b936,$2724c4,$eff347,$9f4815,$5e3500,$da5f66,$474747,$787878,$91ff84,$6864ff,$aeaeae\n\
UnknownPal11,$000000,$ffffff,$ae593f,$9ce9fc,$af5bec,$88d63e,$553ee5,$feff75,$b68119,$7a6600,$e79a84,$727272,$a4a4a4,$d5ff97,$9f8bff,$d5d5d5\n\
VICE3_6_C64S,$000000,$fcfcfc,$a80000,$54fcfc,$a800a8,$00a800,$0000a8,$fcfc00,$a85400,$802c00,$fc5454,$545454,$808080,$54fc54,$5454fc,$a8a8a8\n\
UnknownPal12,$000000,$ffffff,$8b1f00,$6fdfb7,$a73b9f,$4fb317,$0f0097,$f3eb5b,$a34700,$472b1b,$cb7b6f,$454444,$838383,$97ff97,$4f93d3,$bbbbbb\n\
VICE3_6_VICE,$000000,$fdfefc,$be1a24,$30e6c6,$b41ae2,$1fd21e,$211bae,$dff60a,$b84104,$6a3304,$fe4a57,$424540,$70746f,$59fe59,$5f53fe,$a4a7a2\n\
UnknownPal13,$000000,$ffffff,$9d4b32,$82cddf,$9d4ad7,$72be28,$4a32d4,$ddee56,$a36f05,$6d5a00,$ce846f,$646464,$8f8f8f,$b6fb78,$8a76ff,$bababa\n\
VICE3_6_PALette,$000000,$d5d5d5,$72352c,$659fa6,$733a91,$568d35,$2e237d,$aeb75e,$774f1e,$4b3c00,$9c635a,$474747,$6b6b6b,$8fc271,$675db6,$8f8f8f\n\
UnknownPal14,$000000,$ffffff,$7a5550,$9cbcc0,$836295,$83a371,$4b447e,$d3d8a8,$866e52,$5a4f18,$ab8a86,$606060,$8a8a8a,$c2dfb2,$8882b5,$b3b3b3\n\
UnknownPal15,$000000,$ffffff,$884f3e,$8dc0cc,$8d53b5,$79ae4a,$4939ab,$d4df7a,$916d2b,$615300,$b88577,$606060,$8a8a8a,$b9e990,$8679df,$b3b3b3\n\
VICE3_6_Pepto_NTSC_Sony,$000000,$ffffff,$7c352b,$5aa6b1,$694185,$5d8643,$212e78,$cfbe6f,$894a26,$5b3300,$af6459,$434343,$6b6b6b,$a0cb84,$5665b3,$959595\n\
UnknownPal16,$000000,$ffffff,$8c4231,$7bbdc6,$8c42ad,$6bad42,$3931a5,$d6de73,$945a21,$5a4200,$bd736b,$525252,$848484,$adef8c,$7b73de,$adadad\n\
UnknownPal17,$000000,$ffffff,$894133,$7bbec7,$8a45af,$68a941,$3c32a2,$d2db72,$905f25,$5b4700,$bc776e,$555555,$808080,$aaeb85,$7d70da,$ababab\n\
UnknownPal18,$191d19,$fcf9fc,$933a4c,$b6fafa,$d27ded,$6acf6f,$4f44d8,$fbfb8b,$d89c5b,$7f5307,$ef839f,$575753,$a3a7a7,$b7fbbf,$a397ff,$efe9e7\n\
UnknownPal19,$000000,$ffffff,$9b485e,$95ddcb,$9b51ca,$77c153,$3343bd,$eff679,$a46a34,$6e5300,$d08798,$656565,$959595,$c2ffa4,$7f8bf7,$c6c6c6\n\
VICE3_6_Ptoing_CRT,$000000,$ffffff,$cb5c4b,$9bf6ff,$c864f8,$8be34f,$624ced,$ffff86,$cc8829,$886900,$faa192,$7e7e7e,$b0b0b0,$d5ffa5,$ab9aff,$dddddd\n\
UnknownPal20,$010101,$fdf5ff,$893f1d,$7fd9c5,$8947a5,$71b30f,$2115b3,$dbd961,$a75b1f,$5b370b,$db9187,$414141,$818181,$abff8d,$7189e1,$b9b9b9\n\
UnknownPal21,$000000,$fcf4ff,$883e1d,$7ed8c4,$8946a5,$71b20e,$2014b2,$dad961,$a65b1e,$41270a,$d59886,$404040,$808080,$abff8d,$7089e0,$b0b0b0\n\
UnknownPal22,$000000,$ffffff,$794032,$7cb7c8,$8146b0,$6ba63c,$3c2fa4,$ccdb63,$865f24,$544700,$b37869,$4f4f4f,$7e7e7e,$abe77a,$7b6de5,$a8a8a8\n\
UnknownPal23,$000000,$ffffff,$742e32,$69b8b3,$7f3588,$4d9a45,$29278b,$d5d765,$7f4825,$4c3200,$af6165,$424242,$6e6e6e,$98ef8f,$6462d3,$9f9f9f\n\
UnknownPal24,$000000,$f4f4f4,$8c4d3b,$87bfcd,$9153be,$78b143,$4b3ab6,$cedb69,$966e26,$665700,$bd8575,$5f5f5f,$8d8d8d,$b0e582,$897be9,$b0b0b0\n\
UnknownPal25,$000000,$ffffff,$b35f46,$98e4f7,$c05fc7,$77d46e,$5e47eb,$f5ff6b,$b9841e,$826e00,$e59983,$787878,$a6a6a6,$bfffb8,$a18dff,$d1d1d1\n\
UnknownPal26,$000000,$f4f4f4,$984235,$7ec1c8,$974bbc,$6db040,$4434af,$ced970,$9a671e,$624a00,$c07e73,$5d5d5d,$888888,$ace589,$8377de,$afafaf\n\
UnknownPal27,$000000,$ffffff,$8a1f00,$65cfaa,$a53a9f,$4fb015,$1a0f90,$f0ea50,$a04500,$3f1f00,$ca7a5f,$454545,$808080,$95ff95,$4f90d0,$bababa\n\
VICE3_6_CCS64,$101010,$ffffff,$e04040,$60ffff,$e060e0,$40e040,$4040e0,$ffff40,$e0a040,$9c7448,$ffa0a0,$545454,$888888,$a0ffa0,$a0a0ff,$c0c0c0\n\
UnknownPal28,$000000,$ffffff,$8d2f34,$6ad4cd,$9835a4,$4cb442,$2c29b1,$f0f45d,$984e20,$5b3800,$d1676d,$4a4a4a,$7b7b7b,$9fff93,$6d6aff,$b2b2b2\n\
UnknownPal29,$000000,$ffffff,$663333,$77aaaa,$774488,$558844,$332277,$bbcc77,$775522,$443300,$996655,$444444,$666666,$99cc88,$6666bb,$999999\n\
VICE3_6_CommunityColours,$000000,$ffffff,$af2a29,$62d8cc,$b03fb6,$4ac64a,$3739c4,$e4ed4e,$b6591c,$683808,$ea746c,$4d4d4d,$848484,$a6fa9e,$707ce6,$b6b6b5\n\
VICE3_8_Pepto_PAL,$000000,$ffffff,$8d412e,$81d2e7,$9445b7,$65b845,$422ead,$e6fe74,$94621f,$584900,$cc7d67,$555555,$878787,$b7ff95,$8772f9,$bababa\n\
UnknownPal30,$000000,$fdfdfd,$7f2417,$64b8c2,$7f2aab,$51a11e,$2412a0,$cad755,$864900,$4b3000,$b76358,$404040,$707070,$9de871,$6b5cde,$a0a0a0\n\
UnknownPal31,$000000,$ffffff,$d74612,$6ff7ff,$cc35ff,$67f200,$5125ff,$ffff00,$d67c00,$906f00,$ff8a62,$727272,$a4a4a4,$b9ff3f,$9b79ff,$d5d5d5\n\
VICE3_8_VICE_Internal,$000000,$ffffff,$af3c58,$7ef3d6,$aa40f5,$62d532,$2c3dec,$ffff46,$b7631e,$775300,$ee7b95,$626262,$949494,$b7ff86,$7385ff,$cdcdcd\n\
VICE3_6_Pepto_NTSC_CRT,$000000,$ffffff,$9e5541,$93d8ea,$a45bc4,$7ac358,$5541bb,$e9fc87,$a47531,$6c5c00,$d48f7c,$6a6a6a,$999999,$c4ffa4,$9886fa,$c7c7c7\n\
VICE3_6_Colodore_CRT,$000000,$ffffff,$db3a45,$6cffff,$e23bf3,$50f83c,$3f3aff,$ffff3c,$e26909,$935500,$ff808a,$6f6f6f,$a6a6a6,$b1ff9f,$918bff,$e1e1e1\n\
VICE3_6_Pepto_PAL_OldCRT,$000000,$ffffff,$8d422c,$b8fcff,$ca80e7,$7ac559,$5841bb,$eafd88,$ca9b59,$6e5d00,$d5907c,$585858,$a3a3a3,$c4ffa5,$a28fff,$ebebeb\n\
UnknownPal33,$000000,$f5f5f5,$8b392d,$73bbc4,$8b3fb1,$62a834,$3928a8,$cbd666,$915b13,$5c4400,$bb7268,$535353,$7e7e7e,$a5e47e,$796cdb,$a8a8a8\n\
VICE3_6_Pixcen_CRT,$000000,$ffffff,$c85e4f,$9bf6ff,$c462f2,$8be34f,$624ced,$ffff86,$cc8829,$8e6f00,$faa192,$808080,$b0b0b0,$d5ffa5,$ab9aff,$dddddd\n\
VICE3_6_Pepto_NTSC,$000000,$ffffff,$67372b,$70a3b1,$6f3d86,$588c42,$342879,$b7c66e,$6f4e25,$423800,$996659,$434343,$6b6b6b,$9ad183,$6b5eb5,$959595\n\
UnknownPal34,$000000,$ffffff,$7b4336,$75b0c0,$7d4697,$629f4b,$40328d,$c3d571,$825e30,$5a4f0f,$aa7060,$545454,$797979,$9fde87,$7363c4,$9e9e9e\n\
UnknownPal35,$000000,$ffffff,$8c4d3b,$87bfcd,$9153be,$78b143,$4b3ab6,$cedb69,$966e26,$665700,$bd8575,$5f5f5f,$8d8d8d,$b0e582,$897be9,$b0b0b0\n\
UnknownPal_Misc,$000000,$ffffff,$943a32,$62c1c9,$9441b4,$50ab2b,$4130a8,$cddc5e,$985c12,$604600,$c6736a,$555555,$808080,$99ec7b,$7f6fe1,$ababab\n\
VICE3_6_CommunityColours_CRT,$000000,$ffffff,$f93b38,$76ffff,$f355fa,$5bff5b,$5458ff,$ffff4b,$fa7d12,$a05800,$ff998e,$767676,$b5b5b5,$cbffc0,$98a9ff,$e9e9e7\n\
VICE3_6_PC64,$212121,$ffffff,$b52121,$73ffff,$b521b5,$21b521,$2121b5,$ffff21,$b57321,$944221,$ff7373,$737373,$949494,$73ff73,$7373ff,$b5b5b5\n\
VICE3_6_Frodo_CRT,$000000,$ffffff,$ff0000,$00ffff,$ff00ff,$00ff00,$0000ff,$ffff00,$ffb200,$c76600,$ffafaf,$6b6b6b,$b9b9b9,$a5ffa5,$b5b5ff,$fefefe\n\
VICE3_6_Godot,$000000,$ffffff,$880000,$aaffee,$cc44cc,$00cc55,$0000aa,$eeee77,$dd8855,$664400,$fe7777,$333333,$777777,$aaff66,$0088ff,$bbbbbb\n\
VICE3_6_C64HQ,$0a0a0a,$fff8ff,$851f02,$65cda8,$a73b9f,$4dab19,$1a0c92,$ebe353,$a94b02,$441e00,$d28074,$464646,$8b8b8b,$8ef68e,$4d91d1,$bababa\n\
UnknownPal36,$000000,$ffffff,$8b392d,$73bbc4,$8b3fb1,$62a834,$3928a8,$cbd666,$915b13,$5c4400,$bb7268,$535353,$7e7e7e,$a5e47e,$796cdb,$a8a8a8\n\
UnknownPal37,$010101,$fdf5ff,$8a1f00,$65cfaa,$a53a9f,$4fb015,$1a0f90,$f0ea50,$a04500,$3f1f00,$ca7a5f,$454545,$808080,$95ff95,$4f90d0,$bababa\n\
UnknownPal38,$000000,$ffffff,$813339,$74cec8,$8e3c97,$56ac4e,$2e2c9b,$edf171,$8e5029,$553800,$c46c71,$4a4a4a,$9a9a9a,$a9ff9f,$706deb,$b1b1b1\n\
PALette_C64_v1r,$000000,$ffffff,$8c323d,$66bfb3,$8e36a1,$4aa648,$322dab,$cdd256,$8f501a,$533d00,$bd636e,$4e4e4e,$767676,$8ce98b,$6b66e4,$a3a3a3\n\
PEPTOette_a,$000000,$ffffff,$753d3d,$7bb4b4,$7d4488,$5c985c,$343383,$cbcc7c,$7c552f,$523e00,$a76f6f,$4e4e4e,$767676,$9fdb9f,$6d6cbc,$a3a3a3\n\
VICE3_6_C64HQ_CRT,$171717,$ffffff,$c92f00,$7dffd9,$ea51e0,$66e900,$2f12e1,$ffff54,$ee6e00,$743400,$ffaa99,$6e6e6e,$bcbcbc,$aeffae,$65c6ff,$ededed\n\
VICE3_6_C64S_CRT,$000000,$ffffff,$f80000,$59ffff,$f300f3,$00ec00,$0000ff,$ffff00,$ec7a00,$c04400,$ff6f6f,$7e7e7e,$b0b0b0,$60ff60,$7979ff,$dadada\n\
VICE3_6_CCS64_CRT,$222222,$ffffff,$ff5757,$6bffff,$ff7cff,$46ff46,$6060ff,$ffff2a,$ffcf42,$d6a160,$ffcaca,$7e7e7e,$b9b9b9,$c4ffc4,$cfcfff,$f3f3f3\n\
VICE3_6_ChristopherJam,$000000,$ffffff,$7d202c,$4fb3a5,$84258c,$339840,$2a1b9d,$bfd04a,$7f410d,$4c2e00,$b44f5c,$3c3c3c,$646464,$7ce587,$6351db,$939393\n\
VICE3_6_ChristopherJam_CRT,$000000,$ffffff,$bd2f45,$62eddb,$c334cd,$3fd457,$462ceb,$f2ff4d,$bc6200,$7c4d00,$f86f82,$606060,$919191,$9affa9,$8f74ff,$c5c5c5\n\
VICE3_6_Deekay_CRT,$000000,$ffffff,$cd3100,$81ffd8,$eb4ce1,$69f700,$2a19dd,$ffff5b,$e46a00,$75482a,$ffa196,$707070,$b0b0b0,$b9ffb9,$69c4ff,$ebebeb\n\
VICE3_6_Frodo,$000000,$ffffff,$cc0000,$00ffcc,$ff00ff,$00cc00,$0000cc,$ffff00,$ff8800,$884400,$ff8888,$444444,$888888,$88ff88,$8888ff,$cccccc\n\
VICE3_6_Godot_CRT,$000000,$ffffff,$d10000,$cdffff,$ff59ff,$00ff71,$0000ff,$ffff88,$ffb46a,$9b6a00,$ff9a9a,$555555,$a6a6a6,$d1ff72,$00bfff,$eeeeee\n\
VICE3_6_PALette_CRT,$000000,$ffffff,$ac5142,$86d5dd,$aa55d2,$77c542,$4d3ac1,$e1ed72,$af7622,$796100,$d88a7d,$6f6f6f,$999999,$b9fb8f,$9384fc,$c0c0c0\n\
VICE3_6_PC64_CRT,$3c3c3c,$ffffff,$ff2a2a,$86ffff,$fd24fd,$19f719,$3535ff,$ffff00,$f59f15,$d56127,$ff9696,$a2a2a2,$c6c6c6,$8aff8a,$9e9eff,$e8e8e8\n\
VICE3_6_Pepto_NTSC_SonyCRT,$000000,$ffffff,$b9503f,$75ddec,$9c61c3,$82bb5b,$354cba,$fff188,$c76e31,$905300,$ef8a7a,$6a6a6a,$999999,$ccffa6,$7b90f8,$c7c7c7\n\
VICE3_6_RGB,$000000,$ffffff,$ff0000,$00ffff,$ff00ff,$00ff00,$0000ff,$ffff00,$ff8000,$804000,$ff8080,$404040,$808080,$80ff80,$8080ff,$c0c0c0\n\
VICE3_6_RGB_CRT,$000000,$ffffff,$ff0000,$00ffff,$ff00ff,$00ff00,$0000ff,$ffff00,$ffaa00,$be6200,$ffa5a5,$666666,$b0b0b0,$9bff9b,$acacff,$f3f3f3\n\
VICE3_6_VICE_CRT,$000000,$ffffff,$ff1d31,$24ffff,$fc14ff,$0bff09,$372cff,$ffff00,$ff5d00,$a35100,$ff6175,$676c65,$9ea39c,$66ff66,$8876ff,$d5d9d3\n\
VICE3_8_C64HQ,$0d0d0d,$ffffff,$be1e00,$69ffd2,$e53cd8,$51e400,$1f09db,$ffff3f,$eb5800,$5e2300,$ff9986,$585858,$aeaeae,$9fff9f,$4fb9ff,$e9e9e9\n\
VICE3_8_C64S,$000000,$ffffff,$f60000,$45ffff,$f100f1,$00e700,$0000ff,$ffff00,$e76400,$b43100,$ff5959,$696969,$a0a0a0,$4aff4a,$6363ff,$d2d2d2\n\
VICE3_8_CCS64,$141414,$ffffff,$ff4141,$55ffff,$ff68ff,$32ff32,$4b4bff,$ffff1c,$ffc630,$cd8f4a,$ffbfbf,$696969,$aaaaaa,$b7ffb7,$c4c4ff,$f0f0f0\n\
VICE3_8_ChristopherJam,$000000,$ffffff,$b01f32,$4eead3,$b722c3,$2dcb41,$331ce7,$f0ff3a,$ae4e00,$683800,$f6596d,$4b4b4b,$7d7d7d,$87ff99,$7b5fff,$b8b8b8\n\
VICE3_8_Colodore,$000000,$ffffff,$d32831,$58ffff,$db29f1,$3cf82b,$2c27ff,$ffff29,$dc5404,$814000,$ff6c76,$595959,$969696,$a1ff8d,$7d77ff,$dadada\n\
VICE3_8_CommunityColours,$000000,$ffffff,$f82827,$62ffff,$f040fa,$46ff46,$4042ff,$ffff36,$fa6909,$8f4400,$ff8679,$606060,$a5a5a5,$c1ffb4,$8699ff,$e4e4e2\n\
VICE3_8_Deekay,$000000,$ffffff,$c21f00,$6dffd1,$e738db,$53f500,$1c0fd7,$ffff45,$dd5400,$5f331a,$ff8f82,$5a5a5a,$a0a0a0,$abffab,$54b8ff,$e6e6e6\n\
VICE3_8_Frodo,$000000,$ffffff,$ff0000,$00ffff,$ff00ff,$00ff00,$0000ff,$ffff00,$ffa400,$bc5100,$ff9f9f,$555555,$aaaaaa,$94ff94,$a6a6ff,$fefefe\n\
VICE3_8_Godot,$000000,$ffffff,$c80000,$c3ffff,$ff44ff,$00ff5d,$0000ff,$ffff74,$ffa454,$8a5400,$ff8888,$404040,$959595,$c7ff5d,$00b3ff,$eaeaea\n\
VICE3_8_PALette,$000000,$ffffff,$9c3d2e,$72ccd7,$9a40c8,$63b930,$3828b4,$dbe95e,$9f6014,$634c00,$d07769,$595959,$868686,$aafa7c,$8071fb,$b3b3b3\n\
VICE3_8_PALette_6569R1,$000000,$ffffff,$ae1e3b,$95ffff,$f062ff,$4adc4e,$452dfb,$faff49,$ec8d33,$6f4c00,$ff728f,$4c4c4c,$a0a0a0,$9effa1,$9981ff,$f3f3f3\n\
VICE3_8_PALette_6569R5,$000000,$ffffff,$c43350,$6df9dc,$c436dc,$4adc4e,$452dfb,$faff49,$c16208,$6f4c00,$ff728f,$626262,$949494,$9effa1,$8c74ff,$cccccc\n\
VICE3_8_PALette_8565R2,$000000,$ffffff,$c1383c,$6cf6ef,$bf37e0,$4cdc46,$3338f4,$ffff4b,$c1600e,$714c00,$fe767b,$626262,$949494,$a0ff9a,$7b80ff,$cccccc\n\
VICE3_8_PC64,$292929,$ffffff,$ff1c1c,$71ffff,$fe17fe,$0ef50e,$2424ff,$ffff00,$f48c0d,$cc4c19,$ff8383,$909090,$b9b9b9,$76ff76,$8b8bff,$e2e2e2\n\
VICE3_8_Pepto_NTSC,$000000,$ffffff,$8c412e,$81d0e6,$9445b7,$65b742,$412ead,$e5fd73,$94601f,$564700,$cb7c67,$545454,$868686,$b8ff94,$8672f9,$bababa\n\
VICE3_8_Pepto_NTSC_Sony,$000000,$ffffff,$ab3c2c,$5fd6e7,$8a4bb5,$6eae45,$2438ab,$ffef73,$ba581f,$7c3d00,$eb7765,$545454,$868686,$c1ff95,$657df6,$bababa\n\
VICE3_8_Pepto_OldPAL,$000000,$ffffff,$79301d,$a9fdff,$be6ce2,$65b845,$422ead,$e6fe74,$be8a45,$584900,$cc7d67,$424242,$919191,$b7ff95,$917bff,$e6e6e6\n\
VICE3_8_Pixcen,$000000,$ffffff,$bc4a3a,$8af5ff,$b84ef0,$78dd3b,$4c38e9,$ffff71,$c17419,$7b5900,$f98f80,$6a6a6a,$a0a0a0,$cdff95,$9a87ff,$d6d6d6\n\
VICE3_8_Ptoing,$000000,$ffffff,$c14637,$8af5ff,$bc4ff8,$78dd3b,$4c38e9,$ffff71,$c17419,$745300,$f98f80,$696969,$a0a0a0,$cdff95,$9a87ff,$d6d6d6\n\
VICE3_8_RGB,$000000,$ffffff,$ff0000,$00ffff,$ff00ff,$00ff00,$0000ff,$ffff00,$ff9900,$b04c00,$ff9494,$505050,$a0a0a0,$88ff88,$9b9bff,$f0f0f0\n\
VICE3_8_VICE_Original,$000000,$ffffff,$ff1021,$15ffff,$fb0bff,$06ff04,$261cff,$ffff00,$ff4900,$923c00,$ff4b5f,$53564f,$8b918a,$51ff51,$7360ff,$cdd1c9\n\
UnknownPal_Electric,$000000,$ffffff,$813339,$74cec8,$8e3c97,$56ac4e,$2e2c9b,$edf171,$8e5029,$543800,$c46c71,$4a4a4a,$7b7b7b,$a9ff9f,$706deb,$b1b1b1\n\
UnknownPal_Facet,$000000,$ffffff,$72372a,$7cbccb,$7b3e99,$5ea145,$352788,$d0de7b,$7b5324,$453900,$b1705f,$464646,$777777,$b1e696,$7765ce,$ababab\n\
Unknown_FromFacet,$000000,$ffffff,$894036,$7abfc7,$8a46ae,$68a941,$3e31a2,$d0dc71,$905f25,$5c4700,$bb776d,$555555,$808080,$b1e696,$7c70da,$ababab\n\
TheSargeSpecial,$000000,$ffffff,$a52828,$79e4be,$ff44ff,$65c331,$414ed3,$eee550,$c86e28,$864e23,$f39187,$636363,$9f9f9f,$98ff98,$5fa2e2,$c5c5c5\n\
Weird8ColLoadingScreen,$000000,$ffffff,$bd5341,$8feffb,$b957eb,$7fdb41,$553fe5,$ffff77,$badba0,$badba1,$badba2,$badba3,$badba4,$badba5,$badba6,$badba7\n\
FromFoxsFont,$000000,$ffffff,$8c4231,$7bbdc6,$8c42ad,$5ca035,$3931a5,$d6de73,$945a21,$5a4200,$bd736b,$4a4a4a,$848484,$badbad,$7b73de,$adadad\n\
NTSCVICE,$000000,$ffffff,$8f4230,$80d1e6,$9446b8,$64b844,$422ead,$e6fe74,$956321,$594900,$cd7d68,$555555,$878787,$b7ff94,$8771f9,$bababa\n\
';

    var COLOUR_NAMES = ['Black', 'White', 'Red', 'Cyan', 'Purple', 'Green', 'Blue', 'Yellow',
        'Orange', 'Brown', 'Light Red', 'Dark Grey', 'Grey', 'Light Green', 'Light Blue', 'Light Grey'];

    var INNER_W = 320, INNER_H = 200;
    var BORDER_LEFT = 32, BORDER_TOP = 35; // VICE 384x272 -> inner 320x200; borders L32/R32/T35/B37 (not vertically centred)

    // Parse "Name,$c0,..,$c15" -> { name, colors:[16] } or null for invalid lines.
    function parsePalette(line) {
        var parts = line.split(',');
        if (parts.length < 17 || parts[0].trim().charAt(0) === '#') return null;
        var colors = [];
        for (var i = 1; i <= 16; i++) {
            var v = parseInt(parts[i].trim().replace(/^[$#]/, ''), 16);
            if (isNaN(v)) return null;
            colors.push(v & 0xffffff);
        }
        return { name: parts[0].trim(), colors: colors };
    }
    var PALETTES = PALETTE_FILE.split('\n').map(function (l) { return parsePalette(l.trim()); }).filter(Boolean);

    // ROM font lookup (for PETSCII detection). Built lazily from a fonts object
    // shaped like charsetlab/c64fonts.js ({ UPPERCASE, LOWERCASE }: 256 glyphs x
    // 8 bytes each). PETSCII mode is skipped when no fonts are supplied.
    function fontLookup(bytes) {
        var m = {};
        for (var g = 0; g < 256; g++) {
            var k = '';
            for (var i = 0; i < 8; i++) k += String.fromCharCode(bytes[g * 8 + i]);
            if (!(k in m)) m[k] = g;
        }
        return m;
    }
    function buildRom(fonts) {
        if (!fonts || !fonts.UPPERCASE || !fonts.LOWERCASE) return null;
        return { upMap: fontLookup(fonts.UPPERCASE), loMap: fontLookup(fonts.LOWERCASE), fonts: fonts };
    }
    // c64fonts.js declares `const C64Fonts` (a lexical global, not a window
    // property), so probe it by name rather than via the window object.
    function defaultRomFonts() {
        try { return (typeof C64Fonts !== 'undefined') ? C64Fonts : null; }
        catch (e) { return null; }
    }

    // ─── Palette matching ───

    function pickPalette(uniqueRgb) {
        for (var p = 0; p < PALETTES.length; p++) {
            var set = {}, pal = PALETTES[p];
            for (var c = 0; c < 16; c++) set[pal.colors[c]] = c;
            var all = true;
            for (var u = 0; u < uniqueRgb.length; u++) if (!(uniqueRgb[u] in set)) { all = false; break; }
            if (all) return { palette: pal, map: makeExactMap(set), exact: true, worst: 0, offColours: [] };
        }
        // No exact palette - choose the closest-fitting one, then snap each
        // colour to its nearest entry within that palette.
        var best = null, bestErr = Infinity;
        for (p = 0; p < PALETTES.length; p++) {
            var nmap = {}, total = 0, worst = 0, off = [];
            for (u = 0; u < uniqueRgb.length; u++) {
                var nd = nearestWithDist(uniqueRgb[u], PALETTES[p]);
                nmap[uniqueRgb[u]] = nd.idx;
                total += nd.d;
                if (nd.d > 0) off.push({ rgb: uniqueRgb[u], idx: nd.idx, d: nd.d });
                if (nd.d > worst) worst = nd.d;
            }
            if (total < bestErr) { bestErr = total; best = { palette: PALETTES[p], map: nmap, exact: false, worst: Math.round(Math.sqrt(worst)), offColours: off }; }
        }
        return best;
    }
    function makeExactMap(set) { var m = {}; for (var k in set) m[k] = set[k]; return m; }
    function nearestWithDist(rgb, pal) {
        var r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255, best = 0, bestD = Infinity;
        for (var c = 0; c < 16; c++) {
            var pc = pal.colors[c];
            var dr = r - ((pc >> 16) & 255), dg = g - ((pc >> 8) & 255), db = b - (pc & 255);
            var d = dr * dr + dg * dg + db * db;
            if (d < bestD) { bestD = d; best = c; }
        }
        return { idx: best, d: bestD };
    }

    // ─── Window / alignment helpers ───

    // Most common colour in the whole source - the background / off-window fill.
    function dominantColour(idx) {
        var freq = new Uint32Array(16);
        for (var i = 0; i < idx.length; i++) freq[idx[i]]++;
        var best = 0;
        for (var c = 1; c < 16; c++) if (freq[c] > freq[best]) best = c;
        return best;
    }
    // Bounding box (source coords) of pixels that differ from bg, or null if none.
    function sourceBounds(idx, w, h, bg) {
        var minX = w, minY = h, maxX = -1, maxY = -1;
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
                if (idx[y * w + x] !== bg) {
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                }
        return maxX < 0 ? null : { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }
    // Extract a 320x200 window from the source at (ox,oy); off-source pixels = bg.
    function cropWindow(srcIdx, w, h, ox, oy, bg) {
        var out = new Uint8Array(INNER_W * INNER_H);
        for (var y = 0; y < INNER_H; y++) {
            var sy = oy + y;
            for (var x = 0; x < INNER_W; x++) {
                var sx = ox + x;
                out[y * INNER_W + x] = (sx >= 0 && sx < w && sy >= 0 && sy < h) ? srcIdx[sy * w + sx] : bg;
            }
        }
        return out;
    }
    function countUnique(idx) {
        var seen = new Uint8Array(16), n = 0;
        for (var i = 0; i < idx.length; i++) if (!seen[idx[i]]) { seen[idx[i]] = 1; n++; }
        return n;
    }
    // Row-limited conversions (a logo that only occupies the top N char rows):
    // everything below the limit is flattened to the background so chars are
    // only spent on the rows the player will actually display.
    function applyRowLimit(idx, rowLimit, bg) {
        if (rowLimit == null || rowLimit >= 25) return idx;
        var out = idx; // mutate in place - callers pass freshly-cropped grids
        for (var p = rowLimit * 8 * INNER_W; p < out.length; p++) out[p] = bg;
        return out;
    }

    // Up to 8 window offsets (one per 8px alignment) within +/-7px of base, each
    // the closest such offset to base whose window [o, o+size) fully contains the
    // content span [lo, hi]. A null span means a blank screen (no constraint).
    function alignmentOffsets(base, lo, hi, size) {
        var byRes = [];
        for (var o = base - 7; o <= base + 7; o++) {
            if (lo != null && (o > lo || o + size - 1 < hi)) continue;
            var r = ((o % 8) + 8) % 8;
            if (byRes[r] === undefined || Math.abs(o - base) < Math.abs(byRes[r] - base)) byRes[r] = o;
        }
        var out = [];
        for (var i = 0; i < 8; i++) if (byRes[i] !== undefined) out.push(byRes[i]);
        return out;
    }

    // ─── Per-cell colour gathering ───

    function cellColourCounts(grid, x0, y0, cw, gridW, freq) {
        var counts = {};
        for (var ry = 0; ry < 8; ry++) {
            for (var rx = 0; rx < cw; rx++) {
                var v = grid[(y0 + ry) * gridW + (x0 + rx)];
                counts[v] = (counts[v] || 0) + 1;
                if (freq) freq[v]++;
            }
        }
        return counts;
    }
    // Per-cell colour sets (with per-colour pixel counts) plus a global tally.
    function gatherCells(idx) {
        var cells = [], freq = new Uint32Array(16);
        for (var cy = 0; cy < 25; cy++)
            for (var cx = 0; cx < 40; cx++)
                cells.push(cellColourCounts(idx, cx * 8, cy * 8, 8, INNER_W, freq));
        return { cells: cells, freq: freq };
    }
    // The most-frequent global background that leaves every cell <=1 other colour
    // (order-independent), or -1 if no single background works.
    function findHiresBg(cells, freq) {
        var bgFit = -1;
        for (var c = 0; c < 16; c++)
            if (badCellCount(cells, c) === 0 && (bgFit < 0 || freq[c] > freq[bgFit])) bgFit = c;
        return bgFit;
    }
    function badCellCount(cells, bg) {
        var bad = 0;
        for (var n = 0; n < cells.length; n++) {
            var keys = Object.keys(cells[n]), rem = 0;
            for (var m = 0; m < keys.length; m++) if (Number(keys[m]) !== bg) rem++;
            if (rem > 1) bad++;
        }
        return bad;
    }
    function describeCell(counts) {
        return Object.keys(counts).map(function (k) { return COLOUR_NAMES[k] + ' (' + counts[k] + 'px)'; }).join(', ');
    }

    // ─── Charset interning ───

    function keyOf(bytes) { var s = ''; for (var i = 0; i < 8; i++) s += String.fromCharCode(bytes[i]); return s; }
    function intern(map, list, bytes) {
        var k = keyOf(bytes);
        if (k in map) return map[k];
        var id = list.length;
        list.push(bytes);
        map[k] = id;
        return id;
    }

    // flags: { mcm } multicolour hardware ($d016), { ecm } extended-bg ($d011),
    // { previewMulti } charset preview hint (kept for UI parity).
    function finish(mode, charset, screen, colour, cols, flags) {
        var bytes = new Uint8Array(charset.length * 8);
        for (var i = 0; i < charset.length; i++) bytes.set(charset[i], i * 8);
        // A blank (all-zero) glyph can be dropped later (optimiseBlanks) when the
        // invisible-via-colour-RAM trick is valid, so it doesn't count toward the
        // limit: hires always, multicolour/mixed only if $d021 <= 7, ECM always.
        var hasBlank = false;
        for (i = 0; i < charset.length; i++) { var z = true; for (var b = 0; b < 8; b++) if (charset[i][b] !== 0) { z = false; break; } if (z) { hasBlank = true; break; } }
        var eff = charset.length - (hasBlank && (flags.ecm || !flags.mcm || cols.bg <= 7) ? 1 : 0);
        if (eff > 256) {
            return {
                ok: false, mode: mode, over: true, charCount: eff,
                reason: 'Needs ' + eff + ' unique characters - ' + (eff - 256) + ' over the 256-character limit.'
            };
        }
        return {
            ok: true, mode: mode,
            mcm: !!flags.mcm, ecm: !!flags.ecm, previewMulti: !!flags.previewMulti,
            charCount: charset.length, effCount: eff, charset: bytes,
            screen: screen, colour: colour, colours: cols
        };
    }

    // Remove the blank (all-zero) character when it is worth it. A blank cell can
    // be drawn by any character if colour RAM makes it invisible: hires fg = $d021;
    // multicolour/mixed by selecting hires for the cell (colour-RAM bit 3 clear,
    // low bits = $d021, needs $d021 <= 7); ECM by setting colour RAM to the cell's
    // chosen background. We skip it only when the charset already fits AND $d800 is
    // otherwise constant - there, dropping one char isn't worth a varied $d800.
    function optimiseBlanks(r) {
        if (!r || !r.ok || r.isBitmap) return;
        var ecm = r.ecm, mcm = r.mcm, cs = r.charset, bg = r.colours.bg;
        var idxOf = ecm ? function (sc) { return sc & 0x3f; } : function (sc) { return sc; };
        var empty = -1;
        for (var c = 0; c < r.charCount; c++) { var z = true; for (var b = 0; b < 8; b++) if (cs[c * 8 + b] !== 0) { z = false; break; } if (z) { empty = c; break; } }
        if (empty < 0) return;
        var optValid = ecm || !mcm || (bg <= 7);
        var blanks = [], firstVal = -1, allSame = true, nNon = 0;
        for (var n = 0; n < 1000; n++) {
            if (idxOf(r.screen[n]) === empty) blanks.push(n);
            else { var v = r.colour[n]; if (firstVal < 0) firstVal = v; else if (v !== firstVal) allSame = false; nNon++; }
        }
        var limit = ecm ? 64 : 256;
        if (!optValid || (r.charCount <= limit && allSame)) {
            // Keep the blank char; flatten $d800 (a blank cell's colour RAM is free).
            var fill = nNon ? firstVal : (mcm ? ((bg & 7) | 8) : bg);
            for (var i = 0; i < blanks.length; i++) r.colour[blanks[i]] = fill;
            return;
        }
        var B = ecm ? [r.colours.bg, r.colours.bg2, r.colours.bg3, r.colours.bg4] : null;
        var newCs = new Uint8Array((r.charCount - 1) * 8), w2 = 0;
        for (c = 0; c < r.charCount; c++) { if (c === empty) continue; newCs.set(cs.subarray(c * 8, c * 8 + 8), w2 * 8); w2++; }
        // Blank cells now point at a real char drawn invisibly via colour RAM.
        r.blankCells = new Uint8Array(1000);
        for (n = 0; n < 1000; n++) {
            var sc = r.screen[n], ci = idxOf(sc);
            if (ci === empty) { r.colour[n] = ecm ? B[(sc >> 6) & 3] : (mcm ? (bg & 7) : bg); r.screen[n] = ecm ? (sc & 0xc0) : 0; r.blankCells[n] = 1; }
            else { var ni = ci > empty ? ci - 1 : ci; r.screen[n] = ecm ? (ni | (sc & 0xc0)) : ni; }
        }
        r.charset = newCs;
        r.charCount = r.charCount - 1;
    }

    // ─── PETSCII (hires whose chars all belong to one ROM set) ───

    function analysePETSCII(idx, g, ctx) {
        if (!ctx.rom) return { ok: false, reason: 'C64 ROM font data not loaded.' };
        g = g || gatherCells(idx);
        var bg = findHiresBg(g.cells, g.freq);
        if (bg < 0) return { ok: false, reason: 'Not single-background hires, so not PETSCII.' };
        var h = buildHires(idx, bg);
        if (!h.ok) return { ok: false, over: h.over, charCount: h.charCount, reason: h.reason };
        var sets = [['uppercase', ctx.rom.upMap], ['lowercase', ctx.rom.loMap]];
        for (var s = 0; s < sets.length; s++) {
            var map = sets[s][1], all = true;
            for (var ci = 0; ci < h.charCount && all; ci++) {
                var key = '';
                for (var b = 0; b < 8; b++) key += String.fromCharCode(h.charset[ci * 8 + b]);
                if (!(key in map)) all = false;
            }
            if (all) { h.mode = 'PETSCII'; h.petscii = sets[s][0]; return h; }
        }
        return { ok: false, reason: 'Hires, but its chars are not all in one ROM set (uppercase or lowercase).' };
    }

    // ─── Hires analysis (text mode: per-cell foreground + global background) ───

    function analyseHires(idx, g) {
        g = g || gatherCells(idx);
        var cells = g.cells, freq = g.freq;
        var bgFit = findHiresBg(cells, freq);
        if (bgFit >= 0) return buildHires(idx, bgFit);
        var c;

        var tri = [];
        for (var n = 0; n < cells.length; n++) if (Object.keys(cells[n]).length > 2) tri.push(n);
        if (tri.length) {
            var e = tri[0];
            return {
                ok: false, mode: 'Hires', badCells: tri,
                reason: tri.length + ' cell(s) contain 3 or more colours (impossible in hires - each char square is background + one ink). e.g. cell (' + (e % 40) + ',' + ((e / 40) | 0) + '): ' + describeCell(cells[e]) + '.'
            };
        }
        var bestBg = 0, fewest = Infinity;
        for (c = 0; c < 16; c++) { var b = badCellCount(cells, c); if (b < fewest) { fewest = b; bestBg = c; } }
        var conflict = [];
        for (n = 0; n < cells.length; n++) {
            var ks = Object.keys(cells[n]), r = 0;
            for (var m = 0; m < ks.length; m++) if (Number(ks[m]) !== bestBg) r++;
            if (r > 1) conflict.push(n);
        }
        var e2 = conflict[0];
        return {
            ok: false, mode: 'Hires', badCells: conflict, bg: bestBg,
            reason: 'No single global background fits every cell. With ' + COLOUR_NAMES[bestBg] + ' as background, ' + fewest + ' cell(s) still hold two non-background colours, e.g. cell (' + (e2 % 40) + ',' + ((e2 / 40) | 0) + '): ' + describeCell(cells[e2]) + '.'
        };
    }

    function buildHires(idx, bg) {
        var charByKey = {}, charset = [];
        // screen is Uint16Array: the charset can transiently reach 257 glyphs (256
        // content + a droppable blank) before optimiseBlanks removes the blank, so
        // a screen code of 256 must survive the build rather than wrap.
        var screen = new Uint16Array(1000), colour = new Uint8Array(1000);
        for (var cy = 0; cy < 25; cy++) {
            for (var cx = 0; cx < 40; cx++) {
                var bytes = new Uint8Array(8), fg = bg;
                for (var ry = 0; ry < 8; ry++) {
                    var b = 0;
                    for (var rx = 0; rx < 8; rx++) {
                        var v = idx[(cy * 8 + ry) * INNER_W + (cx * 8 + rx)];
                        if (v !== bg) { b |= (0x80 >> rx); fg = v; }
                    }
                    bytes[ry] = b;
                }
                var cellIdx = cy * 40 + cx;
                screen[cellIdx] = intern(charByKey, charset, bytes);
                colour[cellIdx] = fg;
            }
        }
        return finish('Hires', charset, screen, colour, { bg: bg }, { mcm: false, ecm: false, previewMulti: false });
    }

    // ─── Mixed (multicolour text mode; each cell hires or multicolour) ───

    function mixedHiresOk(keys, bg) {
        var ink = -1, cnt = 0;
        for (var m = 0; m < keys.length; m++) { var v = Number(keys[m]); if (v !== bg) { ink = v; if (++cnt > 1) return false; } }
        return cnt === 0 || ink <= 7;
    }

    function mixedHKey(idx, ox, oy, cols, bg) {
        var nonBg = -1, nb = 0;
        for (var i = 0; i < cols.length; i++) if (cols[i] !== bg) { nonBg = cols[i]; if (++nb > 1) return null; }
        if (nb === 1 && nonBg > 7) return null;
        var s = '';
        for (var ry = 0; ry < 8; ry++) { var b = 0; for (var rx = 0; rx < 8; rx++) if (idx[(oy + ry) * INNER_W + ox + rx] !== bg) b |= (0x80 >> rx); s += String.fromCharCode(b); }
        return s;
    }
    function mixedMKey(pairCols, cell, cols, isDoubled, bg, mc1, mc2) {
        if (!isDoubled) return null;
        var ink = -1, ni = 0;
        for (var i = 0; i < cols.length; i++) { var c = cols[i]; if (c !== bg && c !== mc1 && c !== mc2) { ink = c; if (++ni > 1) return null; } }
        if (ni === 1 && ink > 7) return null;
        var s = '', base = cell * 32;
        for (var ry = 0; ry < 8; ry++) { var by = 0; for (var rx = 0; rx < 4; rx++) { var cc = pairCols[base + ry * 4 + rx]; var code = cc === bg ? 0 : cc === mc1 ? 1 : cc === mc2 ? 2 : 3; by |= code << ((3 - rx) * 2); } s += String.fromCharCode(by); }
        return s;
    }

    var NUL8 = '\x00\x00\x00\x00\x00\x00\x00\x00'; // key of the all-zero (blank) glyph

    // When no register triple lets every cell render, find the triple that leaves
    // the FEWEST un-drawable cells and return exactly those cells.
    function mixedBlockingCells(idx, cells, doubled, pairCols, cols, ox, oy, pool) {
        var N = cells.length, bestBad = null;
        for (var bi = 0; bi < pool.length; bi++) {
            var bg = pool[bi];
            for (var mi = 0; mi < pool.length; mi++) {
                var mc1 = pool[mi]; if (mc1 === bg) continue;
                for (var ei = mi + 1; ei < pool.length; ei++) {
                    var mc2 = pool[ei]; if (mc2 === bg) continue;
                    var bad = [];
                    for (var t = 0; t < N; t++) {
                        if (mixedHKey(idx, ox[t], oy[t], cols[t], bg) != null) continue;
                        if (mixedMKey(pairCols, t, cols[t], doubled[t], bg, mc1, mc2) != null) continue;
                        bad.push(t);
                        if (bestBad && bad.length >= bestBad.length) break;
                    }
                    if (!bestBad || bad.length < bestBad.length) bestBad = bad;
                }
            }
        }
        return bestBad || [];
    }

    function analyseMixed(idx, g) {
        g = g || gatherCells(idx);
        var cells = g.cells, freq = g.freq, cols = [], doubled = [], ox = [], oy = [];
        // Per-cell 2px-pair colours (32 values per cell), computed once for the
        // whole sweep.
        var pairCols = new Uint8Array(1000 * 32);
        for (var cy = 0; cy < 25; cy++) {
            for (var cx = 0; cx < 40; cx++) {
                var ci = cy * 40 + cx;
                cols.push(Object.keys(cells[ci]).map(Number));
                ox.push(cx * 8); oy.push(cy * 8);
                var d = true, base = ci * 32;
                for (var ry = 0; ry < 8; ry++)
                    for (var rx = 0; rx < 4; rx++) {
                        var y = cy * 8 + ry, x = cx * 8 + rx * 2;
                        var a = idx[y * INNER_W + x];
                        if (a !== idx[y * INNER_W + x + 1]) d = false;
                        pairCols[base + ry * 4 + rx] = a;
                    }
                doubled.push(d);
            }
        }
        var present = [];
        for (var c = 0; c < 16; c++) if (freq[c]) present.push(c);
        var heavy = present.filter(function (v) { return v > 7; });
        // Candidate global pool (present colours + up to two absent
        // representatives - see the sweep note in charsetlab.js).
        var pool = present.slice(), addedAbsent = 0;
        for (c = 0; c < 16 && addedAbsent < 2; c++) if (!freq[c]) { pool.push(c); addedAbsent++; }
        pool.sort(function (a, b) { return a - b; });
        if (heavy.length > 3) {
            return { ok: false, badCells: mixedBlockingCells(idx, cells, doubled, pairCols, cols, ox, oy, pool),
                reason: 'Mixed mode has 3 global colour slots ($d021/$d022/$d023) and per-cell ink is limited to 0-7, but ' + heavy.length + ' of the colours here are 8-15 and can only be globals.' };
        }

        // Sweep every (bg, mc1, mc2) triple; see charsetlab.js for the full
        // reasoning. Candidates are ranked by the effective char count (raw
        // minus a droppable blank), raw as tie-break.
        var N = cells.length, hKey = new Array(N), best = null;
        for (var bi = 0; bi < pool.length; bi++) {
            var bg = pool[bi], canDrop = bg <= 7 ? 1 : 0;
            for (var k = 0; k < N; k++) hKey[k] = mixedHKey(idx, ox[k], oy[k], cols[k], bg);
            for (var mi = 0; mi < pool.length; mi++) {
                var mc1 = pool[mi];
                if (mc1 === bg) continue;
                for (var ei = 0; ei < pool.length; ei++) {
                    var mc2 = pool[ei];
                    if (mc2 === bg || mc2 === mc1) continue;
                    var hv = true;
                    for (var hh = 0; hh < heavy.length; hh++) if (heavy[hh] !== bg && heavy[hh] !== mc1 && heavy[hh] !== mc2) { hv = false; break; }
                    if (!hv) continue;
                    var set = {}, count = 0, ok = true, hasBlank = false;
                    for (var t = 0; t < N; t++) {
                        var key = hKey[t];
                        if (key == null) { key = mixedMKey(pairCols, t, cols[t], doubled[t], bg, mc1, mc2); if (key == null) { ok = false; break; } }
                        if (!(key in set)) {
                            set[key] = 1; count++;
                            if (key === NUL8) hasBlank = true;
                            if (best && count - canDrop > best.eff) { ok = false; break; }
                        }
                    }
                    if (!ok) continue;
                    var eff = count - (hasBlank ? canDrop : 0);
                    if (!best || eff < best.eff || (eff === best.eff && count < best.count)) best = { eff: eff, count: count, bg: bg, mc1: mc1, mc2: mc2 };
                }
            }
        }
        if (!best) {
            var bad = mixedBlockingCells(idx, cells, doubled, pairCols, cols, ox, oy, pool);
            var e = bad[0];
            return { ok: false, badCells: bad,
                reason: bad.length + ' cell(s) can\'t be drawn: multicolour gives 3 shared colours ($d021/$d022/$d023) plus one per-cell colour (limited to 0-7), so at most 4 per cell with only one that can vary. e.g. cell (' + (e % 40) + ',' + ((e / 40) | 0) + '): ' + describeCell(cells[e]) + '.' };
        }
        return buildMixed(idx, cells, doubled, best.bg, best.mc1, best.mc2);
    }

    function buildMixed(idx, cells, doubled, bg, mc1, mc2) {
        var pat = {}; pat[mc1] = 1; pat[mc2] = 2; pat[bg] = 0;
        var charByKey = {}, charset = [];
        var screen = new Uint16Array(1000), colour = new Uint8Array(1000);
        // A non-doubled single-ink cell can only be drawn hires, so its presence
        // makes the image Mixed; a pure-multicolour image keeps doubled cells
        // multicolour and stays labelled "Multicolour".
        var mixedMode = false;
        for (var t0 = 0; t0 < cells.length; t0++)
            if (!doubled[t0] && mixedHiresOk(Object.keys(cells[t0]), bg)) { mixedMode = true; break; }
        for (var cy = 0; cy < 25; cy++) {
            for (var cx = 0; cx < 40; cx++) {
                var cellIdx = cy * 40 + cx, keys = Object.keys(cells[cellIdx]);
                var bytes = new Uint8Array(8), ink = 0;
                if (mixedHiresOk(keys, bg)) {
                    for (var ry = 0; ry < 8; ry++) {
                        var bv = 0;
                        for (var rx = 0; rx < 8; rx++) {
                            var v = idx[(cy * 8 + ry) * INNER_W + (cx * 8 + rx)];
                            if (v !== bg) { bv |= (0x80 >> rx); ink = v; }
                        }
                        bytes[ry] = bv;
                    }
                    colour[cellIdx] = mixedMode ? (ink & 7) : ((ink & 7) | 8);
                } else {
                    for (ry = 0; ry < 8; ry++) {
                        var byte = 0;
                        for (rx = 0; rx < 4; rx++) {
                            var c = idx[(cy * 8 + ry) * INNER_W + (cx * 8 + rx * 2)];
                            if (!(c in pat) && c !== bg) ink = c;
                            byte |= ((c in pat) ? pat[c] : 3) << ((3 - rx) * 2);
                        }
                        bytes[ry] = byte;
                    }
                    colour[cellIdx] = (ink & 7) | 8; // bit 3 set => multicolour cell
                }
                screen[cellIdx] = intern(charByKey, charset, bytes);
            }
        }
        // Group the charset so hires chars take the low indices and multicolour
        // chars the high ones (a cleaner PRG layout).
        if (mixedMode) {
            var usedHi = new Uint8Array(charset.length);
            for (var s = 0; s < 1000; s++) if (!(colour[s] & 8)) usedHi[screen[s]] = 1;
            var remap = new Int16Array(charset.length), ordered = [], w = 0;
            for (var pass = 0; pass < 2; pass++)
                for (var ci = 0; ci < charset.length; ci++)
                    if (!!usedHi[ci] === (pass === 0)) { remap[ci] = w++; ordered.push(charset[ci]); }
            for (s = 0; s < 1000; s++) screen[s] = remap[screen[s]];
            charset = ordered;
        }
        return finish(mixedMode ? 'Mixed' : 'Multicolour', charset, screen, colour, { bg: bg, mc1: mc1, mc2: mc2 }, { mcm: true, ecm: false, previewMulti: !mixedMode });
    }

    // ─── ECM (extended background colour mode: 4 global backgrounds, <=64 chars) ───

    function analyseECM(idx, g) {
        g = g || gatherCells(idx);
        var cells = g.cells, freq = g.freq;
        var over = [];
        for (var n = 0; n < cells.length; n++) if (Object.keys(cells[n]).length > 2) over.push(n);
        if (over.length) {
            var ex = over[0];
            return { ok: false, badCells: over,
                reason: over.length + ' cell(s) have 3+ colours (ECM allows 2 per cell). e.g. cell (' + (ex % 40) + ',' + ((ex / 40) | 0) + '): ' + describeCell(cells[ex]) + '.' };
        }
        var info = [];
        for (n = 0; n < cells.length; n++) {
            var cols = Object.keys(cells[n]).map(Number), cx = n % 40, cy = (n / 40) | 0, bmps = {};
            for (var t = 0; t < cols.length; t++) bmps[cols[t]] = ecmBitmapStr(idx, cx, cy, cols[t]);
            info.push({ cols: cols, bmps: bmps });
        }
        var typeSeen = {}, types = [];
        for (n = 0; n < info.length; n++) {
            var u = info[n], sc = u.cols.slice().sort(function (a, b) { return a - b; });
            var tk = sc.join(',') + '|' + sc.map(function (c) { return u.bmps[c]; }).join('|');
            if (!(tk in typeSeen)) { typeSeen[tk] = 1; types.push(u); }
        }
        var present = [];
        for (var c = 0; c < 16; c++) if (freq[c]) present.push(c);

        var best = null;
        for (var k = 1; k <= 4; k++) {
            combosOfSize(present, k).forEach(function (B) {
                var plan = ecmPlan(types, B, false);
                if (!plan) return;
                var score = 0;
                for (var i = 0; i < B.length; i++) score += freq[B[i]];
                if (!best || plan.chars < best.chars
                    || (plan.chars === best.chars && plan.raw < best.raw)
                    || (plan.chars === best.chars && plan.raw === best.raw && B.length < best.B.length)
                    || (plan.chars === best.chars && plan.raw === best.raw && B.length === best.B.length && score > best.score))
                    best = { B: B, chars: plan.chars, raw: plan.raw, score: score };
            });
        }
        if (!best) return { ok: false, reason: 'More than 4 background colours would be needed (ECM allows only $d021-$d024).' };
        if (best.chars > 64) return { ok: false, reason: 'Needs more than 64 unique character patterns (ECM limit) - the best layout needs ' + best.chars + '.' };
        var B = best.B.slice().sort(function (a, b) { return freq[b] - freq[a]; }); // dominant background -> $d021
        return buildECM(idx, info, B);
    }

    var ECM_BLANK = '\x00\x00\x00\x00\x00\x00\x00\x00';
    var ECM_SOLID = '\xff\xff\xff\xff\xff\xff\xff\xff';

    function ecmBitmapStr(idx, cx, cy, bg) {
        var s = '';
        for (var ry = 0; ry < 8; ry++) {
            var b = 0;
            for (var rx = 0; rx < 8; rx++) if (idx[(cy * 8 + ry) * INNER_W + (cx * 8 + rx)] !== bg) b |= (0x80 >> rx);
            s += String.fromCharCode(b);
        }
        return s;
    }

    function ecmPlan(units, B, wantAssign) {
        var inB = {}; for (var i = 0; i < B.length; i++) inB[B[i]] = 1;
        var used = {}, free = [], assign = wantAssign ? new Array(units.length) : null;
        for (var n = 0; n < units.length; n++) {
            var u = units[n], cols = u.cols;
            if (cols.length <= 1) {
                var X = cols[0];
                if (X in inB) {
                    var other = -1;
                    for (var j = 0; j < B.length; j++) if (B[j] !== X) { other = B[j]; break; }
                    if (other < 0) { used[ECM_BLANK] = 1; if (assign) assign[n] = X; }
                    else free.push({ n: n, a: { bg: X, bmp: ECM_BLANK }, b: { bg: other, bmp: ECM_SOLID } });
                } else { used[ECM_SOLID] = 1; if (assign) assign[n] = B[0]; }
            } else {
                var c0 = -1, c1 = -1;
                for (var j2 = 0; j2 < cols.length; j2++) if (cols[j2] in inB) { if (c0 < 0) c0 = cols[j2]; else c1 = cols[j2]; }
                if (c0 < 0) return null;
                if (c1 < 0) { used[u.bmps[c0]] = 1; if (assign) assign[n] = c0; }
                else free.push({ n: n, a: { bg: c0, bmp: u.bmps[c0] }, b: { bg: c1, bmp: u.bmps[c1] } });
            }
        }
        for (var f = 0; f < free.length; f++) {
            var fr = free[f], pick;
            if (used[fr.a.bmp]) pick = fr.a;
            else if (used[fr.b.bmp]) pick = fr.b;
            else { pick = (fr.a.bmp <= fr.b.bmp) ? fr.a : fr.b; used[pick.bmp] = 1; }
            if (assign) assign[fr.n] = pick.bg;
        }
        var raw = 0; for (var key in used) raw++;
        return { chars: raw - (ECM_BLANK in used ? 1 : 0), raw: raw, assign: assign };
    }
    function combosOfSize(arr, k) {
        var res = [];
        (function rec(start, cur) {
            if (cur.length === k) { res.push(cur.slice()); return; }
            for (var i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
        })(0, []);
        return res;
    }

    function buildECM(idx, info, B) {
        var plan = ecmPlan(info, B, true), assign = plan.assign;
        var bgIdx = {}; B.forEach(function (c, i) { bgIdx[c] = i; });
        var charByKey = {}, charset = [];
        var screen = new Uint8Array(1000), colour = new Uint8Array(1000);
        var dropBlank = plan.raw > 64, blankCells = dropBlank ? new Uint8Array(1000) : null;
        for (var cy = 0; cy < 25; cy++) {
            for (var cx = 0; cx < 40; cx++) {
                var cellIdx = cy * 40 + cx, bg = assign[cellIdx], cols = info[cellIdx].cols;
                var ink = 0;
                for (var t = 0; t < cols.length; t++) if (cols[t] !== bg) ink = cols[t];
                var bytes = new Uint8Array(8), any = 0;
                for (var ry = 0; ry < 8; ry++) {
                    var bv = 0;
                    for (var rx = 0; rx < 8; rx++) if (idx[(cy * 8 + ry) * INNER_W + (cx * 8 + rx)] !== bg) bv |= (0x80 >> rx);
                    bytes[ry] = bv; any |= bv;
                }
                if (dropBlank && !any) {
                    screen[cellIdx] = bgIdx[bg] << 6;
                    colour[cellIdx] = bg;
                    blankCells[cellIdx] = 1;
                    continue;
                }
                var patIdx = intern(charByKey, charset, bytes);
                if (patIdx > 63) return { ok: false, reason: 'Needs more than 64 unique character patterns (ECM limit).' };
                screen[cellIdx] = (patIdx & 0x3f) | (bgIdx[bg] << 6);
                colour[cellIdx] = ink;
            }
        }
        var r = finish('ECM', charset, screen, colour,
            { bg: B[0], bg2: B[1] != null ? B[1] : B[0], bg3: B[2] != null ? B[2] : B[0], bg4: B[3] != null ? B[3] : B[0] },
            { mcm: false, ecm: true, previewMulti: false });
        if (r.ok && dropBlank) r.blankCells = blankCells;
        return r;
    }

    // ─── Bitmap fallbacks (hires + multicolour bitmap) ───
    // Tried only after every character mode has failed: a bitmap needs no
    // charset budget so it fits far more images, but a charset export is much
    // smaller and more player-friendly, so the character modes stay preferred.
    // Results carry isBitmap/bitmapMode and an 8000-byte `bitmap` instead of a
    // charset; screen/colour keep their usual 1000-byte shapes.

    // Hires bitmap: 2 colours per 8x8 cell, both free per cell (screen RAM
    // upper nibble = %1 pixels, lower nibble = %0 pixels). No globals at all.
    function analyseHiresBitmap(idx, g) {
        g = g || gatherCells(idx);
        var cells = g.cells, bad = [];
        for (var n = 0; n < cells.length; n++) if (Object.keys(cells[n]).length > 2) bad.push(n);
        if (bad.length) {
            var e = bad[0];
            return { ok: false, mode: 'Hires Bitmap', badCells: bad,
                reason: bad.length + ' cell(s) contain 3 or more colours (hires bitmap allows 2 per 8x8 cell). e.g. cell (' + (e % 40) + ',' + ((e / 40) | 0) + '): ' + describeCell(cells[e]) + '.' };
        }
        var bitmap = new Uint8Array(8000), screen = new Uint8Array(1000);
        for (var cy = 0; cy < 25; cy++) {
            for (var cx = 0; cx < 40; cx++) {
                var cell = cy * 40 + cx, counts = cells[cell], cols = Object.keys(counts).map(Number);
                // The busier colour becomes the cell background (%0, fewer set
                // bits); ties and single-colour cells resolve deterministically.
                var bg, fg;
                if (cols.length === 1) { bg = cols[0]; fg = cols[0]; }
                else if (counts[cols[0]] > counts[cols[1]] || (counts[cols[0]] === counts[cols[1]] && cols[0] < cols[1])) { bg = cols[0]; fg = cols[1]; }
                else { bg = cols[1]; fg = cols[0]; }
                screen[cell] = ((fg & 0x0f) << 4) | (bg & 0x0f);
                if (fg !== bg) {
                    for (var ry = 0; ry < 8; ry++) {
                        var b = 0;
                        for (var rx = 0; rx < 8; rx++) if (idx[(cy * 8 + ry) * INNER_W + cx * 8 + rx] === fg) b |= (0x80 >> rx);
                        bitmap[cell * 8 + ry] = b;
                    }
                }
            }
        }
        return { ok: true, mode: 'Hires Bitmap', isBitmap: true, bitmapMode: 'hires',
            mcm: false, ecm: false, bitmap: bitmap, screen: screen,
            colour: new Uint8Array(1000), colours: { bg: 0 } };
    }

    // Multicolour bitmap (koala): 2px-wide pixels; per cell %01/%10 come from
    // the screen nibbles, %11 from colour RAM, %00 from the global $d021 -
    // so one shared background plus up to 3 free colours per cell.
    function analyseMCBitmap(idx, g) {
        g = g || gatherCells(idx);
        var cells = g.cells, freq = g.freq;
        var notDoubled = [];
        for (var cy = 0; cy < 25; cy++) {
            for (var cx = 0; cx < 40; cx++) {
                var ok = true;
                for (var ry = 0; ry < 8 && ok; ry++)
                    for (var rx = 0; rx < 4; rx++) {
                        var y = cy * 8 + ry, x = cx * 8 + rx * 2;
                        if (idx[y * INNER_W + x] !== idx[y * INNER_W + x + 1]) { ok = false; break; }
                    }
                if (!ok) notDoubled.push(cy * 40 + cx);
            }
        }
        if (notDoubled.length) {
            var e0 = notDoubled[0];
            return { ok: false, mode: 'Multicolour Bitmap', badCells: notDoubled,
                reason: notDoubled.length + ' cell(s) contain single-width pixels (multicolour bitmap pixels are 2px wide). e.g. cell (' + (e0 % 40) + ',' + ((e0 / 40) | 0) + ').' };
        }
        // Global background: every cell must keep <= 3 non-background colours.
        // Among fitting candidates prefer the most frequent; if none fits,
        // report the cells blocking the least-bad candidate.
        var bestBg = -1, bestBad = null;
        for (var c = 0; c < 16; c++) {
            var bad = [];
            for (var n = 0; n < cells.length; n++) {
                var ks = Object.keys(cells[n]), rem = 0;
                for (var m = 0; m < ks.length; m++) if (Number(ks[m]) !== c) rem++;
                if (rem > 3) bad.push(n);
            }
            if (!bestBad || bad.length < bestBad.length
                || (bad.length === bestBad.length && bad.length === 0 && freq[c] > freq[bestBg])) {
                bestBad = bad; bestBg = c;
            }
        }
        if (bestBad.length) {
            var e1 = bestBad[0];
            return { ok: false, mode: 'Multicolour Bitmap', badCells: bestBad,
                reason: bestBad.length + ' cell(s) hold more than 4 colours (multicolour bitmap allows the shared background + 3 per cell). With ' + COLOUR_NAMES[bestBg] + ' as background, e.g. cell (' + (e1 % 40) + ',' + ((e1 / 40) | 0) + '): ' + describeCell(cells[e1]) + '.' };
        }
        var bg = bestBg;
        var bitmap = new Uint8Array(8000), screen = new Uint8Array(1000), colour = new Uint8Array(1000);
        for (cy = 0; cy < 25; cy++) {
            for (var cx2 = 0; cx2 < 40; cx2++) {
                var cell = cy * 40 + cx2;
                var others = Object.keys(cells[cell]).map(Number).filter(function (v) { return v !== bg; }).sort(function (a, b) { return a - b; });
                var hi = others[0] != null ? others[0] : 0;
                var lo = others[1] != null ? others[1] : 0;
                var cr = others[2] != null ? others[2] : 0;
                screen[cell] = ((hi & 0x0f) << 4) | (lo & 0x0f);
                colour[cell] = cr & 0x0f;
                for (var ry2 = 0; ry2 < 8; ry2++) {
                    var by = 0;
                    for (var rx2 = 0; rx2 < 4; rx2++) {
                        var v = idx[(cy * 8 + ry2) * INNER_W + cx2 * 8 + rx2 * 2];
                        var code = v === bg ? 0 : v === hi ? 1 : v === lo ? 2 : 3;
                        by |= code << ((3 - rx2) * 2);
                    }
                    bitmap[cell * 8 + ry2] = by;
                }
            }
        }
        return { ok: true, mode: 'Multicolour Bitmap', isBitmap: true, bitmapMode: 'mc',
            mcm: true, ecm: false, bitmap: bitmap, screen: screen, colour: colour, colours: { bg: bg } };
    }

    // ─── Mode driver + alignment search ───

    // Multicolour and Mixed are one hardware mode ($d016 MCM=1, per-cell bit 3);
    // analyseMixed covers both. Keys are the names accepted in opts.modes. The
    // bitmap modes come last: they are the fallback when no charset mode fits.
    var ALL_MODES = [
        ['petscii', 'PETSCII', analysePETSCII],
        ['hires', 'Hires', analyseHires],
        ['mixed', 'Mixed', analyseMixed],
        ['ecm', 'ECM', analyseECM],
        ['bitmap-hires', 'Hires Bitmap', analyseHiresBitmap],
        ['bitmap-mc', 'Multicolour Bitmap', analyseMCBitmap]
    ];
    function modeFns(modes) {
        if (!modes || !modes.length) return ALL_MODES;
        var want = {};
        for (var i = 0; i < modes.length; i++) {
            var k = String(modes[i]).toLowerCase();
            if (k === 'bitmap') { want['bitmap-hires'] = 1; want['bitmap-mc'] = 1; }
            else want[k] = 1;
        }
        return ALL_MODES.filter(function (m) { return want[m[0]]; });
    }

    // Run the modes in order on one grid. `chosen` is the first that fits (the
    // simplest compatible format). Every requested mode is evaluated so the
    // caller can list all compatible formats.
    function runModes(idx, fns, ctx) {
        var attempts = [], chosen = null, g = gatherCells(idx);
        for (var k = 0; k < fns.length; k++) {
            var r = fns[k][2](idx, g, ctx);
            r.label = r.mode || fns[k][1];
            attempts.push(r);
            if (r.ok && !chosen) chosen = r;
        }
        return { attempts: attempts, chosen: chosen };
    }

    // Slide the 320x200 screen window over the source (+/-7px per axis, one
    // offset per 8px alignment) and keep the offset fitting the simplest mode
    // with the fewest chars. See charsetlab.js for the full reasoning.
    function shiftSearchSource(srcIdx, w, h, offX0, offY0, fns, ctx, rowLimit) {
        var bg = dominantColour(srcIdx), bb = sourceBounds(srcIdx, w, h, bg);
        var xs = alignmentOffsets(offX0, bb && bb.minX, bb && bb.maxX, INNER_W);
        var ys = alignmentOffsets(offY0, bb && bb.minY, bb && bb.maxY, INNER_H);
        var grids = [];
        for (var yi = 0; yi < ys.length; yi++)
            for (var xi = 0; xi < xs.length; xi++)
                grids.push({ dx: offX0 - xs[xi], dy: offY0 - ys[yi], idx: applyRowLimit(cropWindow(srcIdx, w, h, xs[xi], ys[yi], bg), rowLimit, bg) });
        for (var gi = 0; gi < grids.length; gi++) grids[gi].cells = gatherCells(grids[gi].idx);
        for (var m = 0; m < fns.length; m++) {
            var best = null;
            for (var g = 0; g < grids.length; g++) {
                var r = fns[m][2](grids[g].idx, grids[g].cells, ctx);
                if (!r.ok) continue;
                var d = Math.abs(grids[g].dx) + Math.abs(grids[g].dy);
                // Bitmap results have no char count - every fitting offset ties
                // at 0, so the least-displaced window wins via the d tiebreak.
                var eff = r.effCount != null ? r.effCount : (r.charCount != null ? r.charCount : 0);
                if (!best || eff < best.eff || (eff === best.eff && r.charCount < best.chosen.charCount)
                    || (eff === best.eff && r.charCount === best.chosen.charCount && d < best.d)) {
                    r.label = r.mode || fns[m][1];
                    best = { chosen: r, idx: grids[g].idx, dx: grids[g].dx, dy: grids[g].dy, d: d, eff: eff };
                }
            }
            if (best) return best;
        }
        return null;
    }

    // ─── Public API ───

    /**
     * Analyse RGBA pixels of a 320x200 image, a 384x272 VICE grab, or a
     * partial-height 320xH logo strip (H a multiple of 8, at most 200 - e.g.
     * the 320x72 DefaultWithLogo art); the rows below a strip are filled with
     * its dominant colour.
     * @param {Uint8Array|Uint8ClampedArray} rgba - w*h*4 bytes
     * @param {number} w
     * @param {number} h
     * @param {object} [opts]
     *   - modes:    subset of ['petscii','hires','mixed','ecm','bitmap'] (default: all)
     *   - shift:    enable the +/-7px alignment search (default true)
     *   - rowLimit: only the top N char rows carry content; rows below are
     *               flattened to the background before analysis (default 25)
     *   - romFonts: { UPPERCASE, LOWERCASE } glyph data for PETSCII detection
     * @returns report { w, h, is384, match, border, attempts, chosen, idx, shift }
     */
    function analyse(rgba, w, h, opts) {
        opts = opts || {};
        var is384 = (w === 384 && h === 272);
        if (!is384 && !(w === INNER_W && h >= 8 && h <= INNER_H && h % 8 === 0)) {
            throw new Error('Image must be 320x200, 384x272, or a 320-wide strip of whole char rows (got ' + w + 'x' + h + 'px).');
        }
        var fns = modeFns(opts.modes);
        var ctx = { rom: buildRom(opts.romFonts || defaultRomFonts()) };
        var rowLimit = (opts.rowLimit == null) ? 25 : opts.rowLimit;
        var shiftOn = opts.shift !== false;

        var unique = {};
        for (var p = 0; p < w * h; p++) { var j = p * 4; unique[(rgba[j] << 16) | (rgba[j + 1] << 8) | rgba[j + 2]] = true; }
        var match = pickPalette(Object.keys(unique).map(Number));
        var srcIdx = new Uint8Array(w * h);
        for (p = 0; p < w * h; p++) { j = p * 4; srcIdx[p] = match.map[(rgba[j] << 16) | (rgba[j + 1] << 8) | rgba[j + 2]]; }
        var border = is384 ? nearestWithDist((rgba[(4 * w + 4) * 4] << 16) | (rgba[(4 * w + 4) * 4 + 1] << 8) | rgba[(4 * w + 4) * 4 + 2], match.palette).idx : 0;

        var offX0 = is384 ? BORDER_LEFT : 0, offY0 = is384 ? BORDER_TOP : 0;
        var best = shiftOn ? shiftSearchSource(srcIdx, w, h, offX0, offY0, fns, ctx, rowLimit) : null;
        var chosenIdx = best ? best.idx
            : applyRowLimit(cropWindow(srcIdx, w, h, offX0, offY0, dominantColour(srcIdx)), rowLimit, dominantColour(srcIdx));
        match.uniqueCount = countUnique(chosenIdx);
        var run = runModes(chosenIdx, fns, ctx);
        for (var ai = 0; ai < run.attempts.length; ai++) if (run.attempts[ai].ok) optimiseBlanks(run.attempts[ai]);
        return {
            w: w, h: h, is384: is384, match: match, border: border,
            attempts: run.attempts, chosen: run.chosen, idx: chosenIdx,
            shift: best ? { dx: best.dx, dy: best.dy } : { dx: 0, dy: 0 }
        };
    }

    // The most useful "why it failed" line from a report with no fitted mode:
    // prefer the actionable over-the-char-limit reason, else explain the last
    // mode tried. The modes run simplest-first, so the last one is the most
    // permissive - quoting the first instead reads as though hires was the only
    // mode considered, which is baffling when the image is a multicolour one.
    function failureReason(report) {
        var attempts = report && report.attempts;
        if (attempts) {
            for (var i = 0; i < attempts.length; i++) if (attempts[i] && !attempts[i].ok && attempts[i].over) return attempts[i].reason;
            var tried = [];
            for (i = 0; i < attempts.length; i++) if (attempts[i] && attempts[i].label) tried.push(attempts[i].label);
            for (i = attempts.length - 1; i >= 0; i--) {
                if (attempts[i] && !attempts[i].ok && attempts[i].reason) {
                    return 'no C64 mode fits this image (tried ' + tried.join(', ') + '). '
                        + attempts[i].label + ', the most permissive of them: ' + attempts[i].reason;
                }
            }
        }
        return 'No supported charset mode fits this image.';
    }

    // ─── Logo blob (the fixed container visualizer configs slice up) ───
    //
    // One container for EVERY logo type, charset or bitmap. Its first 10004
    // bytes are exactly the WASM png-converter's C64 bitmap container (load
    // address + koala layout), so existing bitmap-logo memory maps keep
    // working; the extra register bytes follow it.
    //
    //   0x0000  load address $6000 (compatibility, 2 bytes)
    //   0x0002  graphics: bitmap 8000 bytes, or the charset (charCount x 8,
    //           zero-padded - a charset never exceeds 2048 bytes)
    //   0x1F42  screen RAM 1000 bytes (bitmap colour nibbles / char codes;
    //           PETSCII results are remapped to ROM codes)
    //   0x232A  colour RAM 1000 bytes
    //   0x2712  background ($d021)
    //   0x2713  logo mode (see LOGO_MODES; 0/1 match the old bitmapMode byte)
    //   0x2714  $d022 (multicolour 1 / ECM bg2)
    //   0x2715  $d023 (multicolour 2 / ECM bg3)
    //   0x2716  $d024 (ECM bg4)
    //   0x2717  charCount lo, 0x2718 charCount hi (0 for bitmap results)
    //   0x2719  total size
    var LOGO_BLOB = { GFX: 0x0002, SCREEN: 0x1F42, COLOUR: 0x232A, BACKGROUND: 0x2712, MODE: 0x2713, D022: 0x2714, D023: 0x2715, D024: 0x2716, CHARCOUNT: 0x2717, SIZE: 0x2719 };
    // Values 0/1 are the WithLogo players' original BitmapMode byte; the text
    // modes extend it (player-side $d011/$d016 lookup tables index by this).
    var LOGO_MODES = { BITMAP_MC: 0, BITMAP_HIRES: 1, HIRES: 2, MULTICOLOUR: 3, ECM: 4, PETSCII_UPPER: 5, PETSCII_LOWER: 6 };

    function buildLogoBlob(r, romFonts) {
        if (!r || !r.ok) throw new Error('buildLogoBlob needs a fitted analysis result');
        var blob = new Uint8Array(LOGO_BLOB.SIZE);
        blob[0] = 0x00; blob[1] = 0x60;
        var i, mode;
        var screen = new Uint8Array(1000);
        if (r.isBitmap) {
            blob.set(r.bitmap, LOGO_BLOB.GFX);
            for (i = 0; i < 1000; i++) screen[i] = r.screen[i] & 0xff;
            mode = r.bitmapMode === 'hires' ? LOGO_MODES.BITMAP_HIRES : LOGO_MODES.BITMAP_MC;
        } else if (r.petscii) {
            // Remap compact glyph indices back to ROM codes so the screen works
            // against the standard ROM font (no custom charset shipped).
            var rom = buildRom(romFonts || defaultRomFonts());
            if (!rom) throw new Error('PETSCII logo blob needs the ROM font data (c64fonts)');
            var map = (r.petscii === 'uppercase') ? rom.upMap : rom.loMap;
            var toRom = new Array(r.charCount);
            for (var k = 0; k < r.charCount; k++) {
                var key = '';
                for (var b = 0; b < 8; b++) key += String.fromCharCode(r.charset[k * 8 + b]);
                toRom[k] = map[key];
            }
            for (i = 0; i < 1000; i++) screen[i] = toRom[r.screen[i]] & 0xff;
            mode = r.petscii === 'uppercase' ? LOGO_MODES.PETSCII_UPPER : LOGO_MODES.PETSCII_LOWER;
        } else {
            blob.set(r.charset.subarray(0, Math.min(r.charset.length, 2048)), LOGO_BLOB.GFX);
            for (i = 0; i < 1000; i++) screen[i] = r.screen[i] & 0xff;
            mode = r.ecm ? LOGO_MODES.ECM : (r.mcm ? LOGO_MODES.MULTICOLOUR : LOGO_MODES.HIRES);
        }
        blob.set(screen, LOGO_BLOB.SCREEN);
        blob.set(r.colour.subarray(0, 1000), LOGO_BLOB.COLOUR);

        var cols = r.colours;
        blob[LOGO_BLOB.BACKGROUND] = cols.bg & 0x0f;
        blob[LOGO_BLOB.MODE] = mode;
        if (r.ecm) {
            blob[LOGO_BLOB.D022] = cols.bg2 & 0x0f;
            blob[LOGO_BLOB.D023] = cols.bg3 & 0x0f;
            blob[LOGO_BLOB.D024] = cols.bg4 & 0x0f;
        } else if (r.mcm && !r.isBitmap) {
            blob[LOGO_BLOB.D022] = cols.mc1 & 0x0f;
            blob[LOGO_BLOB.D023] = cols.mc2 & 0x0f;
        }
        if (!r.isBitmap) {
            blob[LOGO_BLOB.CHARCOUNT] = r.charCount & 0xff;
            blob[LOGO_BLOB.CHARCOUNT + 1] = (r.charCount >> 8) & 0xff;
        }
        return blob;
    }

    // ─── Rendering a result back to pixels ───
    //
    // What the C64 will actually put on screen, from the same fields
    // buildLogoBlob ships to it - so a preview drawn from this cannot disagree
    // with the export. The VIC rules, per mode:
    //
    //   Hires char   bit set -> colour RAM, clear -> $d021
    //   Multicolour  colour-RAM bit 3 set: pixel PAIRS, %00 $d021, %01 $d022,
    //                %10 $d023, %11 colour RAM low 3 bits. Bit 3 clear: the cell
    //                is hires with fg = colour RAM low 3 bits (this is what
    //                "Mixed" uses per cell).
    //   ECM          screen bits 6-7 pick one of $d021-$d024 for the background;
    //                the glyph is the low 6 bits; set bits take colour RAM.
    //   Hires bitmap bit set -> screen high nibble, clear -> screen low nibble.
    //   MC bitmap    pairs: %00 $d021, %01 screen high, %10 screen low,
    //                %11 colour RAM low nibble.
    //
    // Returns { width, height, rgba } - rgba suits ImageData directly.
    function renderResult(r) {
        if (!r || !r.ok) return null;
        var pal = (typeof globalThis !== 'undefined' && globalThis.C64_PALETTE_RGB)
            || (typeof window !== 'undefined' && window.C64_PALETTE_RGB);
        if (!pal) throw new Error('renderResult needs the shared C64 palette (c64-palette.js)');

        var W = INNER_W, H = INNER_H;
        var out = new Uint8ClampedArray(W * H * 4);
        var cols = r.colours || {};
        var bg = (cols.bg || 0) & 0x0f;
        var backgrounds = [bg, (cols.bg2 || 0) & 0x0f, (cols.bg3 || 0) & 0x0f, (cols.bg4 || 0) & 0x0f];
        var mc1 = (cols.mc1 || 0) & 0x0f, mc2 = (cols.mc2 || 0) & 0x0f;

        function put(x, y, c) {
            if (x < 0 || x >= W || y < 0 || y >= H) return;
            var rgb = pal[c & 0x0f] || pal[0];
            var o = (y * W + x) * 4;
            out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255;
        }

        var rows = Math.min(25, Math.floor(H / 8));
        for (var cy = 0; cy < rows; cy++) {
            for (var cx = 0; cx < 40; cx++) {
                var cell = cy * 40 + cx;
                var sc = r.screen[cell] & 0xff;
                var cr = r.colour[cell] & 0x0f;
                for (var ry = 0; ry < 8; ry++) {
                    var y = cy * 8 + ry;
                    var byte, wide, pairs;
                    if (r.isBitmap) {
                        byte = r.bitmap[cell * 8 + ry];
                        if (r.bitmapMode === 'mc') {
                            pairs = [bg, (sc >> 4) & 0x0f, sc & 0x0f, cr];
                            for (var p = 0; p < 4; p++) {
                                var v = (byte >> ((3 - p) * 2)) & 3;
                                put(cx * 8 + p * 2, y, pairs[v]);
                                put(cx * 8 + p * 2 + 1, y, pairs[v]);
                            }
                        } else {
                            for (var b = 0; b < 8; b++) {
                                put(cx * 8 + b, y, (byte & (0x80 >> b)) ? ((sc >> 4) & 0x0f) : (sc & 0x0f));
                            }
                        }
                        continue;
                    }

                    var glyph = r.ecm ? (sc & 0x3f) : sc;
                    byte = r.charset[glyph * 8 + ry] || 0;
                    if (r.ecm) {
                        var ebg = backgrounds[(sc >> 6) & 3];
                        for (var e = 0; e < 8; e++) put(cx * 8 + e, y, (byte & (0x80 >> e)) ? cr : ebg);
                        continue;
                    }
                    wide = r.mcm && (cr & 8);
                    if (wide) {
                        pairs = [bg, mc1, mc2, cr & 7];
                        for (var q = 0; q < 4; q++) {
                            var vv = (byte >> ((3 - q) * 2)) & 3;
                            put(cx * 8 + q * 2, y, pairs[vv]);
                            put(cx * 8 + q * 2 + 1, y, pairs[vv]);
                        }
                    } else {
                        // Hires: in a multicolour-capable result the ink is the
                        // low 3 bits (bit 3 is the mode flag), otherwise all four.
                        var fg = r.mcm ? (cr & 7) : cr;
                        for (var h = 0; h < 8; h++) put(cx * 8 + h, y, (byte & (0x80 >> h)) ? fg : bg);
                    }
                }
            }
        }
        return { width: W, height: H, rgba: out };
    }

    return {
        COLOUR_NAMES: COLOUR_NAMES,
        PALETTES: PALETTES,
        INNER_W: INNER_W,
        INNER_H: INNER_H,
        LOGO_BLOB: LOGO_BLOB,
        LOGO_MODES: LOGO_MODES,
        analyse: analyse,
        failureReason: failureReason,
        buildLogoBlob: buildLogoBlob,
        renderResult: renderResult
    };
});
