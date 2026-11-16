---
group: scripting
summary: "your own work(x, rate) in python"
related: [measure, spectrum, decode]
---

Your own DSP in a block: `params.code` defines `work(x, rate)` returning `y` (same rate), `(y, new_rate)` or
None (nothing downstream). numpy (`np`), liquid-dsp (`dsp`), the modem helpers (`modem`), the lab (`lab.sample`,
`lab.log`, `lab.event`, `lab.value`, `lab.blob`) and a persistent `state` dict are in scope. Prototype a block, add a
custom measurement or adapt formats between blocks; promote it to a real block class in python/ once it works.
