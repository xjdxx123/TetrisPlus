#!/bin/bash
INPUT="bgm_vaporwave.m4a"

ffmpeg -i "$INPUT" -ss 0       -to 226.6  -c copy bgm_01.m4a
ffmpeg -i "$INPUT" -ss 226.6   -to 479.2  -c copy bgm_02.m4a
ffmpeg -i "$INPUT" -ss 479.2   -to 678.2  -c copy bgm_03.m4a
ffmpeg -i "$INPUT" -ss 678.2   -to 926.9  -c copy bgm_04.m4a
ffmpeg -i "$INPUT" -ss 926.9   -to 1174.1 -c copy bgm_05.m4a
ffmpeg -i "$INPUT" -ss 1174.1  -to 1419.9 -c copy bgm_06.m4a
ffmpeg -i "$INPUT" -ss 1419.9  -to 1635.1 -c copy bgm_07.m4a
ffmpeg -i "$INPUT" -ss 1635.1  -to 1864.8 -c copy bgm_08.m4a
ffmpeg -i "$INPUT" -ss 1864.8  -to 2101.6 -c copy bgm_09.m4a
ffmpeg -i "$INPUT" -ss 2101.6  -to 2363.1 -c copy bgm_10.m4a
ffmpeg -i "$INPUT" -ss 2363.1  -to 2577.6 -c copy bgm_11.m4a
ffmpeg -i "$INPUT" -ss 2577.6  -to 2769.0 -c copy bgm_12.m4a
ffmpeg -i "$INPUT" -ss 2769.0  -to 3041.6 -c copy bgm_13.m4a
ffmpeg -i "$INPUT" -ss 3041.6             -c copy bgm_14.m4a