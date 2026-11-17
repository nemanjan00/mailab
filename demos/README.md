# Demos

Self-contained walkthroughs that populate a mAIlab instance over MCP and
show a feature end to end. Each has a script, a README and a screenshot.

- [beacon-to-iq](beacon-to-iq/) — parse a radio frame with kaitai, modulate
  it with OFDM, and demodulate it back in a flowgraph.
- [uart-over-fsk](uart-over-fsk/) — a UART text stream GFSK-modulated through
  AWGN and demodulated back to text (discriminator, Gardner clock recovery,
  adaptive slicer).
- [qam-ber](qam-ber/) — PRBS-15 → 16-QAM → AWGN, with a live `sweep`-driven
  BER-vs-SNR waterfall.

Each script takes the lab URL and populates a fresh `DATA_DIR`; see the
individual READMEs for run instructions.
