# Pricing Model Sim

[中文](README.md) · [Project index](https://github.com/AndyZhang666666/AndyZhang666666/blob/main/PROJECTS.en.md) · [Live demo](https://andyzhang666666.github.io/pricing-model-sim/)

When comparing unlocks and subscriptions, are we still counting the same users?

![Actual Pricing Model Sim interface](https://andyzhang666666.github.io/assets/work/showcase/pricing-crop.jpg)

## Product decisions

- Fix the starting cohort before tracing unlocks, subscriptions and exits.
- A user who switches or leaves cannot repeatedly reappear in the original pool.
- Change one field per sweep while retaining all other inputs.

## Walkthrough

1. Choose a retention preset or enter your own retention and payment assumptions.
2. Compare three mechanisms and inspect monthly populations, channel revenue and discounted payback.
3. Sweep one assumption and export inputs, model version and results.

## Run mode and limits

A conditional revenue model requiring no key. Price changes do not automatically affect conversion or retention. Inputs are uncalibrated, so rankings are not market-optimal prices.

The examples support product reasoning, not measured business outcomes. Inspect population definitions, costs and uncalibrated assumptions before applying the result to a real experiment.

## Develop locally

```sh
npm ci
npm run dev
```

Open `http://localhost:3000/pricing-model-sim/`. The repository base path is part of the URL.

## Lightweight checks

```sh
npm run test-model
npm run sanity
npm run build
```

These commands are provided for reproduction; this documentation update did not run a new model benchmark.

## Documentation

- [Product scope](docs/PRD.md)
- [Model assumptions](docs/ASSUMPTIONS.md)
- [Design decisions](docs/DECISIONS.md)
- [Validation records](docs/VALIDATION.md)
- [Implementation details and original records, Chinese](README.md)

Use the repository’s existing licence and notices. This update does not change usage rights.
