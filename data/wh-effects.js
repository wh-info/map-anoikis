// Wormhole effect modifiers per (effect, class). Exposed as window.WH_EFFECTS.
// Values are pre-formatted strings ("+30%" / "-15%") indexed by class:
//   values[0] = Class 1, values[5] = Class 6.
// Special-case lookups handled in main.js:
//   C13     → use Wolf-Rayet C6 row (all C13 systems are WR by spec).
//   Drifter → use the system's effect, but always C2 magnitude.
//   Thera / no effect → no tooltip wired.
window.WH_EFFECTS = {
  "Pulsar": [
    { label: "Shield Capacity",         values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Armor Resists",           values: ["-15%","-22%","-29%","-36%","-43%","-50%"]  },
    { label: "Capacitor Recharge Time", values: ["-15%","-22%","-29%","-36%","-43%","-50%"]  },
    { label: "Signature Radius",        values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "NOS & Neut Drain Amount", values: ["+30%","+44%","+58%","+72%","+86%","+100%"] }
  ],
  "Black Hole": [
    { label: "Missile Velocity",                    values: ["+15%","+22%","+29%","+36%","+43%","+50%"]  },
    { label: "Missile Explosion Velocity",          values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Vorton Projectors Explosion Velocity",values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Ship Velocity",                       values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Stasis Webifier Strength",            values: ["-15%","-22%","-29%","-36%","-43%","-50%"]  },
    { label: "Inertia",                             values: ["+15%","+22%","+29%","+36%","+43%","+50%"]  },
    { label: "Targeting Range",                     values: ["+30%","+44%","+58%","+72%","+86%","+100%"] }
  ],
  "Cataclysmic Variable": [
    { label: "Local Armor Repair Amount",  values: ["-15%","-22%","-29%","-36%","-43%","-50%"]  },
    { label: "Remote Armor Repair Amount", values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Local Shield Repair Amount", values: ["-15%","-22%","-29%","-36%","-43%","-50%"]  },
    { label: "Shield Transfer Amount",     values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Capacitor Capacity",         values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Capacitor Recharge Time",    values: ["+15%","+22%","+29%","+36%","+43%","+50%"]  },
    { label: "Remote Cap Transmitter Amount", values: ["-15%","-22%","-29%","-36%","-43%","-50%"] }
  ],
  "Magnetar": [
    { label: "Weapon Damage",                     values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Missile Explosion Radius",          values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Vorton Projectors Explosion Radius",values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Drone Tracking",                    values: ["-15%","-22%","-29%","-36%","-43%","-50%"]  },
    { label: "Targeting Range",                   values: ["-15%","-22%","-29%","-36%","-43%","-50%"]  },
    { label: "Tracking Speed",                    values: ["-15%","-22%","-29%","-36%","-43%","-50%"]  },
    { label: "Target Painter Strength",           values: ["-15%","-22%","-29%","-36%","-43%","-50%"]  }
  ],
  "Red Giant": [
    { label: "Heat Damage",       values: ["+15%","+22%","+29%","+36%","+43%","+50%"]  },
    { label: "Overload Bonus",    values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Smart Bomb Range",  values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Smart Bomb Damage", values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Bomb Damage",       values: ["+30%","+44%","+58%","+72%","+86%","+100%"] }
  ],
  "Wolf-Rayet": [
    { label: "Armor HP",            values: ["+30%","+44%","+58%","+72%","+86%","+100%"] },
    { label: "Shield Resist",       values: ["-15%","-22%","-29%","-36%","-43%","-50%"]  },
    { label: "Small Weapon Damage", values: ["+60%","+88%","+116%","+144%","+172%","+200%"] },
    { label: "Signature Radius",    values: ["-15%","-22%","-29%","-36%","-43%","-50%"]  }
  ]
};
