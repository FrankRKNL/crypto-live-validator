# Intraday Edge Research - Phase 2

Date: 2026-04-11
Data: Binance 1h, ~41 days, 5 assets

## Hypotheses

### H1: Mean Reversion After Extreme Moves
- NOT RSI -- mechanical outlier detection in return space
- Entry: |2h return| > N sigma -> check reversal in next N hours
- Result: NO ROBUST EDGE

### H2: Time-of-Day Session Effects
- Session overlap vs solo trading hours
- Result: NO TIME EDGE

### H3: Volatility Regime Shift Response
- After vol regime change, short-term behavior predictable
- Result: NO REGIME SHIFT EDGE

## Data Limitation
1000 1h candles (~41 days) is SHORT for statistical significance.
All conclusions should be treated as PRELIMINARY.

```json
{
  "BTC": {
    "h1": {
      "result": "NO ROBUST EDGE",
      "best": {
        "sigma": 2.5,
        "fw": 2,
        "n": 71,
        "revRate": "56.3%",
        "avgFwd": "-0.042%",
        "t": "-0.42",
        "p": "0.2706",
        "verdict": "NO EDGE"
      },
      "all": [
        {
          "sigma": 2.5,
          "fw": 2,
          "n": 71,
          "revRate": "56.3%",
          "avgFwd": "-0.042%",
          "t": "-0.42",
          "p": "0.2706",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 2.5,
          "fw": 4,
          "n": 71,
          "revRate": "50.7%",
          "avgFwd": "-0.050%",
          "t": "-0.48",
          "p": "0.3362",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 2.5,
          "fw": 6,
          "n": 71,
          "revRate": "50.7%",
          "avgFwd": "0.080%",
          "t": "0.54",
          "p": "0.3992",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 2.5,
          "fw": 12,
          "n": 71,
          "revRate": "49.3%",
          "avgFwd": "0.093%",
          "t": "0.52",
          "p": "0.3842",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 2,
          "n": 49,
          "revRate": "57.1%",
          "avgFwd": "-0.123%",
          "t": "-1.20",
          "p": "0.9231",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 4,
          "n": 49,
          "revRate": "55.1%",
          "avgFwd": "-0.052%",
          "t": "-0.47",
          "p": "0.3226",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 6,
          "n": 49,
          "revRate": "55.1%",
          "avgFwd": "0.141%",
          "t": "0.81",
          "p": "0.6910",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 12,
          "n": 49,
          "revRate": "49.0%",
          "avgFwd": "0.174%",
          "t": "0.79",
          "p": "0.6771",
          "verdict": "NO EDGE"
        }
      ]
    },
    "h2": {
      "result": "NO TIME EDGE",
      "hourly": [
        {
          "name": "00-04",
          "n": 164,
          "mean": "0.0298%",
          "std": "0.454%",
          "posRate": "50.6%",
          "t": "0.84",
          "sig": "no"
        },
        {
          "name": "04-08",
          "n": 165,
          "mean": "0.0127%",
          "std": "0.407%",
          "posRate": "51.5%",
          "t": "0.40",
          "sig": "no"
        },
        {
          "name": "08-12",
          "n": 168,
          "mean": "-0.0036%",
          "std": "0.486%",
          "posRate": "52.4%",
          "t": "-0.10",
          "sig": "no"
        },
        {
          "name": "12-16",
          "n": 168,
          "mean": "0.0210%",
          "std": "0.684%",
          "posRate": "48.8%",
          "t": "0.40",
          "sig": "no"
        },
        {
          "name": "16-20",
          "n": 168,
          "mean": "-0.0095%",
          "std": "0.430%",
          "posRate": "48.2%",
          "t": "-0.29",
          "sig": "no"
        },
        {
          "name": "20-24",
          "n": 166,
          "mean": "0.0130%",
          "std": "0.467%",
          "posRate": "51.2%",
          "t": "0.36",
          "sig": "no"
        }
      ],
      "overlapVsNon": {
        "nOv": 456,
        "nNon": 543,
        "t": "0.15"
      }
    },
    "h3": {
      "result": "NO VOL REGIME SHIFT EDGE",
      "results": [
        {
          "fw": 2,
          "lthN": 26,
          "lthMean": "-0.102",
          "lthT": "-0.78",
          "lthSig": false,
          "htlN": 27,
          "htlMean": "0.185",
          "htlT": "1.23",
          "htlSig": false
        },
        {
          "fw": 4,
          "lthN": 26,
          "lthMean": "0.317",
          "lthT": "1.28",
          "lthSig": false,
          "htlN": 27,
          "htlMean": "0.244",
          "htlT": "1.41",
          "htlSig": false
        },
        {
          "fw": 8,
          "lthN": 26,
          "lthMean": "0.496",
          "lthT": "1.76",
          "lthSig": false,
          "htlN": 27,
          "htlMean": "0.153",
          "htlT": "0.71",
          "htlSig": false
        },
        {
          "fw": 12,
          "lthN": 26,
          "lthMean": "0.717",
          "lthT": "2.10",
          "lthSig": false,
          "htlN": 27,
          "htlMean": "0.314",
          "htlT": "1.01",
          "htlSig": false
        }
      ]
    }
  },
  "ETH": {
    "h1": {
      "result": "NO ROBUST EDGE",
      "best": {
        "sigma": 2.5,
        "fw": 2,
        "n": 77,
        "revRate": "50.6%",
        "avgFwd": "-0.064%",
        "t": "-0.55",
        "p": "0.4208",
        "verdict": "NO EDGE"
      },
      "all": [
        {
          "sigma": 2.5,
          "fw": 2,
          "n": 77,
          "revRate": "50.6%",
          "avgFwd": "-0.064%",
          "t": "-0.55",
          "p": "0.4208",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 2.5,
          "fw": 4,
          "n": 76,
          "revRate": "48.7%",
          "avgFwd": "0.051%",
          "t": "0.40",
          "p": "0.2475",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 2.5,
          "fw": 6,
          "n": 76,
          "revRate": "46.1%",
          "avgFwd": "0.177%",
          "t": "1.02",
          "p": "0.8470",
          "verdict": "MOMENTUM"
        },
        {
          "sigma": 2.5,
          "fw": 12,
          "n": 76,
          "revRate": "51.3%",
          "avgFwd": "0.285%",
          "t": "1.29",
          "p": "0.9463",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 2,
          "n": 48,
          "revRate": "60.4%",
          "avgFwd": "-0.203%",
          "t": "-1.41",
          "p": "0.9677",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 4,
          "n": 47,
          "revRate": "55.3%",
          "avgFwd": "-0.110%",
          "t": "-0.77",
          "p": "0.6583",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 6,
          "n": 47,
          "revRate": "51.1%",
          "avgFwd": "0.073%",
          "t": "0.35",
          "p": "0.2019",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 12,
          "n": 47,
          "revRate": "53.2%",
          "avgFwd": "-0.014%",
          "t": "-0.06",
          "p": "0.0162",
          "verdict": "NO EDGE"
        }
      ]
    },
    "h2": {
      "result": "NO TIME EDGE",
      "hourly": [
        {
          "name": "00-04",
          "n": 164,
          "mean": "0.0437%",
          "std": "0.576%",
          "posRate": "51.2%",
          "t": "0.97",
          "sig": "no"
        },
        {
          "name": "04-08",
          "n": 165,
          "mean": "0.0023%",
          "std": "0.496%",
          "posRate": "48.5%",
          "t": "0.06",
          "sig": "no"
        },
        {
          "name": "08-12",
          "n": 168,
          "mean": "0.0042%",
          "std": "0.675%",
          "posRate": "50.6%",
          "t": "0.08",
          "sig": "no"
        },
        {
          "name": "12-16",
          "n": 168,
          "mean": "0.0188%",
          "std": "0.834%",
          "posRate": "48.2%",
          "t": "0.29",
          "sig": "no"
        },
        {
          "name": "16-20",
          "n": 168,
          "mean": "0.0410%",
          "std": "0.586%",
          "posRate": "50.6%",
          "t": "0.91",
          "sig": "no"
        },
        {
          "name": "20-24",
          "n": 166,
          "mean": "-0.0127%",
          "std": "0.660%",
          "posRate": "47.6%",
          "t": "-0.25",
          "sig": "no"
        }
      ],
      "overlapVsNon": {
        "nOv": 456,
        "nNon": 543,
        "t": "0.04"
      }
    },
    "h3": {
      "result": "NO VOL REGIME SHIFT EDGE",
      "results": [
        {
          "fw": 2,
          "lthN": 20,
          "lthMean": "0.027",
          "lthT": "0.10",
          "lthSig": false,
          "htlN": 21,
          "htlMean": "0.131",
          "htlT": "0.73",
          "htlSig": false
        },
        {
          "fw": 4,
          "lthN": 20,
          "lthMean": "0.064",
          "lthT": "0.21",
          "lthSig": false,
          "htlN": 21,
          "htlMean": "0.144",
          "htlT": "0.54",
          "htlSig": false
        },
        {
          "fw": 8,
          "lthN": 20,
          "lthMean": "0.408",
          "lthT": "1.11",
          "lthSig": false,
          "htlN": 21,
          "htlMean": "-0.036",
          "htlT": "-0.12",
          "htlSig": false
        },
        {
          "fw": 12,
          "lthN": 20,
          "lthMean": "1.219",
          "lthT": "2.54",
          "lthSig": false,
          "htlN": 21,
          "htlMean": "0.374",
          "htlT": "0.85",
          "htlSig": false
        }
      ]
    }
  },
  "BNB": {
    "h1": {
      "result": "NO ROBUST EDGE",
      "best": {
        "sigma": 2.5,
        "fw": 2,
        "n": 82,
        "revRate": "54.9%",
        "avgFwd": "-0.152%",
        "t": "-2.02",
        "p": "0.9984",
        "verdict": "NO EDGE"
      },
      "all": [
        {
          "sigma": 2.5,
          "fw": 2,
          "n": 82,
          "revRate": "54.9%",
          "avgFwd": "-0.152%",
          "t": "-2.02",
          "p": "0.9984",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 2.5,
          "fw": 4,
          "n": 82,
          "revRate": "57.3%",
          "avgFwd": "-0.097%",
          "t": "-0.96",
          "p": "0.8085",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 2.5,
          "fw": 6,
          "n": 82,
          "revRate": "57.3%",
          "avgFwd": "0.092%",
          "t": "0.68",
          "p": "0.5674",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 2.5,
          "fw": 12,
          "n": 82,
          "revRate": "50.0%",
          "avgFwd": "-0.009%",
          "t": "-0.05",
          "p": "0.0161",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 2,
          "n": 50,
          "revRate": "64.0%",
          "avgFwd": "-0.099%",
          "t": "-1.09",
          "p": "0.8796",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 4,
          "n": 50,
          "revRate": "66.0%",
          "avgFwd": "-0.141%",
          "t": "-1.23",
          "p": "0.9327",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 6,
          "n": 50,
          "revRate": "66.0%",
          "avgFwd": "0.033%",
          "t": "0.22",
          "p": "0.0990",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 12,
          "n": 50,
          "revRate": "52.0%",
          "avgFwd": "-0.119%",
          "t": "-0.62",
          "p": "0.4958",
          "verdict": "NO EDGE"
        }
      ]
    },
    "h2": {
      "result": "NO TIME EDGE",
      "hourly": [
        {
          "name": "00-04",
          "n": 164,
          "mean": "0.0103%",
          "std": "0.391%",
          "posRate": "50.6%",
          "t": "0.34",
          "sig": "no"
        },
        {
          "name": "04-08",
          "n": 165,
          "mean": "-0.0133%",
          "std": "0.347%",
          "posRate": "52.7%",
          "t": "-0.49",
          "sig": "no"
        },
        {
          "name": "08-12",
          "n": 168,
          "mean": "-0.0137%",
          "std": "0.458%",
          "posRate": "50.6%",
          "t": "-0.39",
          "sig": "no"
        },
        {
          "name": "12-16",
          "n": 168,
          "mean": "-0.0050%",
          "std": "0.529%",
          "posRate": "50.6%",
          "t": "-0.12",
          "sig": "no"
        },
        {
          "name": "16-20",
          "n": 168,
          "mean": "0.0205%",
          "std": "0.343%",
          "posRate": "51.8%",
          "t": "0.77",
          "sig": "no"
        },
        {
          "name": "20-24",
          "n": 166,
          "mean": "-0.0072%",
          "std": "0.389%",
          "posRate": "50.6%",
          "t": "-0.24",
          "sig": "no"
        }
      ],
      "overlapVsNon": {
        "nOv": 456,
        "nNon": 543,
        "t": "0.15"
      }
    },
    "h3": {
      "result": "NO VOL REGIME SHIFT EDGE",
      "results": [
        {
          "fw": 2,
          "lthN": 14,
          "lthMean": "-0.198",
          "lthT": "-1.26",
          "lthSig": false,
          "htlN": 15,
          "htlMean": "0.051",
          "htlT": "0.35",
          "htlSig": false
        },
        {
          "fw": 4,
          "lthN": 14,
          "lthMean": "0.174",
          "lthT": "0.74",
          "lthSig": false,
          "htlN": 15,
          "htlMean": "0.014",
          "htlT": "0.09",
          "htlSig": false
        },
        {
          "fw": 8,
          "lthN": 14,
          "lthMean": "0.349",
          "lthT": "1.00",
          "lthSig": false,
          "htlN": 15,
          "htlMean": "-0.101",
          "htlT": "-0.91",
          "htlSig": false
        },
        {
          "fw": 12,
          "lthN": 14,
          "lthMean": "0.533",
          "lthT": "1.09",
          "lthSig": false,
          "htlN": 15,
          "htlMean": "-0.076",
          "htlT": "-0.23",
          "htlSig": false
        }
      ]
    }
  },
  "SOL": {
    "h1": {
      "result": "NO ROBUST EDGE",
      "best": {
        "sigma": 2.5,
        "fw": 2,
        "n": 84,
        "revRate": "51.2%",
        "avgFwd": "-0.160%",
        "t": "-1.39",
        "p": "0.9655",
        "verdict": "NO EDGE"
      },
      "all": [
        {
          "sigma": 2.5,
          "fw": 2,
          "n": 84,
          "revRate": "51.2%",
          "avgFwd": "-0.160%",
          "t": "-1.39",
          "p": "0.9655",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 2.5,
          "fw": 4,
          "n": 84,
          "revRate": "56.0%",
          "avgFwd": "-0.148%",
          "t": "-0.91",
          "p": "0.7755",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 2.5,
          "fw": 6,
          "n": 84,
          "revRate": "51.2%",
          "avgFwd": "-0.056%",
          "t": "-0.29",
          "p": "0.1462",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 2.5,
          "fw": 12,
          "n": 84,
          "revRate": "46.4%",
          "avgFwd": "0.033%",
          "t": "0.13",
          "p": "0.0472",
          "verdict": "MOMENTUM"
        },
        {
          "sigma": 3,
          "fw": 2,
          "n": 52,
          "revRate": "50.0%",
          "avgFwd": "-0.216%",
          "t": "-1.54",
          "p": "0.9828",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 4,
          "n": 52,
          "revRate": "55.8%",
          "avgFwd": "-0.274%",
          "t": "-1.67",
          "p": "0.9906",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 6,
          "n": 52,
          "revRate": "53.8%",
          "avgFwd": "-0.046%",
          "t": "-0.21",
          "p": "0.0911",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 12,
          "n": 52,
          "revRate": "44.2%",
          "avgFwd": "0.006%",
          "t": "0.02",
          "p": "0.0064",
          "verdict": "MOMENTUM"
        }
      ]
    },
    "h2": {
      "result": "NO TIME EDGE",
      "hourly": [
        {
          "name": "00-04",
          "n": 164,
          "mean": "0.0063%",
          "std": "0.627%",
          "posRate": "47.6%",
          "t": "0.13",
          "sig": "no"
        },
        {
          "name": "04-08",
          "n": 165,
          "mean": "-0.0162%",
          "std": "0.514%",
          "posRate": "44.8%",
          "t": "-0.40",
          "sig": "no"
        },
        {
          "name": "08-12",
          "n": 168,
          "mean": "-0.0293%",
          "std": "0.629%",
          "posRate": "47.6%",
          "t": "-0.60",
          "sig": "no"
        },
        {
          "name": "12-16",
          "n": 168,
          "mean": "0.0151%",
          "std": "0.848%",
          "posRate": "47.0%",
          "t": "0.23",
          "sig": "no"
        },
        {
          "name": "16-20",
          "n": 168,
          "mean": "0.0135%",
          "std": "0.647%",
          "posRate": "48.2%",
          "t": "0.27",
          "sig": "no"
        },
        {
          "name": "20-24",
          "n": 166,
          "mean": "0.0155%",
          "std": "0.677%",
          "posRate": "47.6%",
          "t": "0.30",
          "sig": "no"
        }
      ],
      "overlapVsNon": {
        "nOv": 456,
        "nNon": 543,
        "t": "0.62"
      }
    },
    "h3": {
      "result": "NO VOL REGIME SHIFT EDGE",
      "results": [
        {
          "fw": 2,
          "lthN": 23,
          "lthMean": "0.026",
          "lthT": "0.12",
          "lthSig": false,
          "htlN": 24,
          "htlMean": "0.299",
          "htlT": "2.55",
          "htlSig": false
        },
        {
          "fw": 4,
          "lthN": 23,
          "lthMean": "0.020",
          "lthT": "0.07",
          "lthSig": false,
          "htlN": 24,
          "htlMean": "0.019",
          "htlT": "0.10",
          "htlSig": false
        },
        {
          "fw": 8,
          "lthN": 23,
          "lthMean": "0.425",
          "lthT": "1.18",
          "lthSig": false,
          "htlN": 24,
          "htlMean": "0.056",
          "htlT": "0.21",
          "htlSig": false
        },
        {
          "fw": 12,
          "lthN": 23,
          "lthMean": "0.236",
          "lthT": "0.55",
          "lthSig": false,
          "htlN": 24,
          "htlMean": "-0.214",
          "htlT": "-0.53",
          "htlSig": false
        }
      ]
    }
  },
  "XRP": {
    "h1": {
      "result": "NO ROBUST EDGE",
      "best": {
        "sigma": 2.5,
        "fw": 2,
        "n": 70,
        "revRate": "52.9%",
        "avgFwd": "-0.215%",
        "t": "-1.72",
        "p": "0.9926",
        "verdict": "NO EDGE"
      },
      "all": [
        {
          "sigma": 2.5,
          "fw": 2,
          "n": 70,
          "revRate": "52.9%",
          "avgFwd": "-0.215%",
          "t": "-1.72",
          "p": "0.9926",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 2.5,
          "fw": 4,
          "n": 70,
          "revRate": "44.3%",
          "avgFwd": "-0.086%",
          "t": "-0.61",
          "p": "0.4869",
          "verdict": "MOMENTUM"
        },
        {
          "sigma": 2.5,
          "fw": 6,
          "n": 70,
          "revRate": "44.3%",
          "avgFwd": "-0.130%",
          "t": "-0.77",
          "p": "0.6600",
          "verdict": "MOMENTUM"
        },
        {
          "sigma": 2.5,
          "fw": 12,
          "n": 70,
          "revRate": "52.9%",
          "avgFwd": "-0.561%",
          "t": "-2.67",
          "p": "1.0000",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 2,
          "n": 52,
          "revRate": "53.8%",
          "avgFwd": "-0.186%",
          "t": "-1.18",
          "p": "0.9177",
          "verdict": "NO EDGE"
        },
        {
          "sigma": 3,
          "fw": 4,
          "n": 52,
          "revRate": "44.2%",
          "avgFwd": "-0.037%",
          "t": "-0.22",
          "p": "0.0945",
          "verdict": "MOMENTUM"
        },
        {
          "sigma": 3,
          "fw": 6,
          "n": 52,
          "revRate": "40.4%",
          "avgFwd": "-0.099%",
          "t": "-0.47",
          "p": "0.3242",
          "verdict": "MOMENTUM"
        },
        {
          "sigma": 3,
          "fw": 12,
          "n": 52,
          "revRate": "51.9%",
          "avgFwd": "-0.484%",
          "t": "-2.04",
          "p": "0.9986",
          "verdict": "NO EDGE"
        }
      ]
    },
    "h2": {
      "result": "NO TIME EDGE",
      "hourly": [
        {
          "name": "00-04",
          "n": 164,
          "mean": "0.0150%",
          "std": "0.561%",
          "posRate": "48.2%",
          "t": "0.34",
          "sig": "no"
        },
        {
          "name": "04-08",
          "n": 165,
          "mean": "-0.0191%",
          "std": "0.423%",
          "posRate": "47.9%",
          "t": "-0.58",
          "sig": "no"
        },
        {
          "name": "08-12",
          "n": 168,
          "mean": "-0.0301%",
          "std": "0.530%",
          "posRate": "45.8%",
          "t": "-0.74",
          "sig": "no"
        },
        {
          "name": "12-16",
          "n": 168,
          "mean": "-0.0080%",
          "std": "0.757%",
          "posRate": "42.9%",
          "t": "-0.14",
          "sig": "no"
        },
        {
          "name": "16-20",
          "n": 168,
          "mean": "0.0103%",
          "std": "0.464%",
          "posRate": "51.8%",
          "t": "0.29",
          "sig": "no"
        },
        {
          "name": "20-24",
          "n": 166,
          "mean": "0.0271%",
          "std": "0.549%",
          "posRate": "50.0%",
          "t": "0.64",
          "sig": "no"
        }
      ],
      "overlapVsNon": {
        "nOv": 456,
        "nNon": 543,
        "t": "0.56"
      }
    },
    "h3": {
      "result": "NO VOL REGIME SHIFT EDGE",
      "results": [
        {
          "fw": 2,
          "lthN": 19,
          "lthMean": "0.336",
          "lthT": "1.28",
          "lthSig": false,
          "htlN": 20,
          "htlMean": "0.121",
          "htlT": "1.09",
          "htlSig": false
        },
        {
          "fw": 4,
          "lthN": 19,
          "lthMean": "0.277",
          "lthT": "1.10",
          "lthSig": false,
          "htlN": 20,
          "htlMean": "-0.025",
          "htlT": "-0.15",
          "htlSig": false
        },
        {
          "fw": 8,
          "lthN": 19,
          "lthMean": "0.646",
          "lthT": "1.85",
          "lthSig": false,
          "htlN": 20,
          "htlMean": "-0.077",
          "htlT": "-0.21",
          "htlSig": false
        },
        {
          "fw": 12,
          "lthN": 19,
          "lthMean": "1.248",
          "lthT": "2.74",
          "lthSig": false,
          "htlN": 20,
          "htlMean": "0.451",
          "htlT": "1.01",
          "htlSig": false
        }
      ]
    }
  }
}
```
