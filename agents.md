# Agent instructions — Rocket Stove Airflow Sim 2

Before changing physics, read `docs/IMPLEMENTATION_STATUS.yaml` and `docs/PHYSICS_V3_PLAN.yaml`.

Hard invariants:

1. Tracers visualize airflow; they do not determine oxygen or combustion.
2. Smoke cannot disappear merely because oxygen exists or a blue tracer touches it.
3. Closed regions cannot receive environmental oxygen or tracer replenishment.
4. Pyrolysis is driven by heat and available straw; it does not require oxygen-rich conditions.
5. Char oxidation requires heat and oxygen.
6. Mineral ash is a separate non-combustible reservoir. Carbon does not become mineral ash.
7. Finite fuel cannot generate infinite products.
8. Do not migrate physics and GPU implementation in the same unverified step.
9. CPU Physics v3 is the reference backend until parity tests are established.
10. A visual improvement is not evidence that the physics is correct.

After physics changes run:

```bash
npm test
```

After WGSL implementation is enabled, additionally run:

```bash
npx vgpu check
```
