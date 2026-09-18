/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/glance_vault.json`.
 */
export type GlanceVault = {
  "address": "DP7QYPQZh2XqMREGWQ5MNo1vgGUSZbfAzJu3uRQATnmy",
  "metadata": {
    "name": "glanceVault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Glance vault: policy-bound delegated stock buys on Solana"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "docs": [
        "Two-step admin rotation, step 2: the proposed key proves control by signing."
      ],
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "newAdmin",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "allowMint",
      "docs": [
        "Curate one stock mint, with its issuer rule. Checked now as well as at every swap: a",
        "mint that does not already carry the required delegate is refused."
      ],
      "discriminator": [
        240,
        28,
        240,
        70,
        124,
        240,
        245,
        225
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "allowedMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  108,
                  108,
                  111,
                  119,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "issuerDelegate",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    },
    {
      "name": "deposit",
      "docs": [
        "Anyone may deposit a stable mint into a vault (gifts, top-ups). Destination is fixed to the vault's ATA."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "depositor",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "depositorAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "depositor"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultAta",
          "docs": [
            "ATA address is deterministic and the ATA program fixes owner = vault, so init_if_needed cannot be poisoned."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "disallowMint",
      "docs": [
        "Remove a mint from the catalog. Vaults keep what they hold and can still withdraw it;",
        "the agent can no longer buy or sell it."
      ],
      "discriminator": [
        75,
        176,
        193,
        187,
        34,
        158,
        118,
        121
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "allowedMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  108,
                  108,
                  111,
                  119,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "allowed_mint.mint",
                "account": "allowedMint"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "executeSwapDesk",
      "docs": [
        "OTC fill: vault pays `amount_in` of the input mint to the desk, the desk pays",
        "`amount_out` of the output mint into the vault's ATA. Both the agent and the",
        "desk sign, so the price is agreed by two independent keys; the vault enforces",
        "direction, curation, caps, and that its own account is the destination."
      ],
      "discriminator": [
        156,
        92,
        57,
        253,
        21,
        139,
        91,
        157
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "agent",
          "docs": [
            "The delegated signer. Also pays rent for the vault's output ATA on first use."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "desk",
          "docs": [
            "The config-approved counterparty. Must co-sign: it is giving up tokens."
          ],
          "signer": true
        },
        {
          "name": "inputMint"
        },
        {
          "name": "outputMint"
        },
        {
          "name": "allowedMint",
          "docs": [
            "The stock side's AllowedMint (the output on a buy, the input on a sell); checked in the handler."
          ]
        },
        {
          "name": "vaultIn",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "inputTokenProgram"
              },
              {
                "kind": "account",
                "path": "inputMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultOut",
          "docs": [
            "Destination is structurally the vault's own ATA (spec §8.3 check 4)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "outputTokenProgram"
              },
              {
                "kind": "account",
                "path": "outputMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "deskIn",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "desk"
              },
              {
                "kind": "account",
                "path": "inputTokenProgram"
              },
              {
                "kind": "account",
                "path": "inputMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "deskOut",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "desk"
              },
              {
                "kind": "account",
                "path": "outputTokenProgram"
              },
              {
                "kind": "account",
                "path": "outputMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "inputTokenProgram"
        },
        {
          "name": "outputTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amountIn",
          "type": "u64"
        },
        {
          "name": "amountOut",
          "type": "u64"
        },
        {
          "name": "minOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "executeSwapRouter",
      "docs": [
        "Router fill (Jupiter on mainnet). `route_data` is the router instruction data built",
        "off-chain; `remaining_accounts` are the router's accounts in order. The vault PDA is",
        "the only signer we extend into the CPI; every other remaining account must be a",
        "non-signer, and no vault-owned token account other than vault_in/vault_out may be",
        "handed to the router."
      ],
      "discriminator": [
        8,
        38,
        105,
        233,
        162,
        61,
        2,
        254
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "agent",
          "writable": true,
          "signer": true
        },
        {
          "name": "inputMint"
        },
        {
          "name": "outputMint"
        },
        {
          "name": "allowedMint",
          "docs": [
            "The stock side's AllowedMint; checked in the handler."
          ]
        },
        {
          "name": "vaultIn",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "inputTokenProgram"
              },
              {
                "kind": "account",
                "path": "inputMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultOut",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "outputTokenProgram"
              },
              {
                "kind": "account",
                "path": "outputMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "routerProgram"
        },
        {
          "name": "inputTokenProgram"
        },
        {
          "name": "outputTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amountIn",
          "type": "u64"
        },
        {
          "name": "minOut",
          "type": "u64"
        },
        {
          "name": "routeData",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "initConfig",
      "docs": [
        "One-time config creation. Only the program's upgrade authority may call it, which",
        "closes the classic \"anyone initializes the global config first\" race after deploy."
      ],
      "discriminator": [
        23,
        235,
        115,
        232,
        168,
        96,
        1,
        231
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "program",
          "docs": [
            "Anti-frontrun: only the upgrade authority may create the config."
          ],
          "address": "DP7QYPQZh2XqMREGWQ5MNo1vgGUSZbfAzJu3uRQATnmy"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "configParams"
            }
          }
        }
      ]
    },
    {
      "name": "initializeVault",
      "docs": [
        "Onboarding in one signature (spec §7.2): create the vault, set policy + agent,",
        "create the vault's stable-mint ATA and deposit the initial amount."
      ],
      "discriminator": [
        48,
        191,
        163,
        44,
        71,
        129,
        63,
        164
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "stableMint"
        },
        {
          "name": "ownerStableAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "stableTokenProgram"
              },
              {
                "kind": "account",
                "path": "stableMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultStableAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "stableTokenProgram"
              },
              {
                "kind": "account",
                "path": "stableMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "stableTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "policyParams"
            }
          }
        },
        {
          "name": "depositAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "pause",
      "docs": [
        "Instant and unconditional (spec §8.2)."
      ],
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "proposeAdmin",
      "docs": [
        "Two-step admin rotation, step 1."
      ],
      "discriminator": [
        121,
        214,
        199,
        212,
        87,
        39,
        117,
        234
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "revokeAgent",
      "discriminator": [
        227,
        60,
        209,
        125,
        240,
        117,
        163,
        73
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "setPolicy",
      "discriminator": [
        40,
        133,
        12,
        157,
        235,
        202,
        2,
        132
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "policyParams"
            }
          }
        }
      ]
    },
    {
      "name": "unpause",
      "discriminator": [
        169,
        144,
        4,
        38,
        10,
        141,
        188,
        255
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "updateConfig",
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "configParams"
            }
          }
        }
      ]
    },
    {
      "name": "withdraw",
      "docs": [
        "Owner withdraws any token the vault holds, to the owner's own ATA. No timelock: Glance never gates access to funds."
      ],
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "vaultAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "allowedMint",
      "discriminator": [
        173,
        229,
        179,
        46,
        121,
        164,
        247,
        6
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    }
  ],
  "events": [
    {
      "name": "configUpdated",
      "discriminator": [
        40,
        241,
        230,
        122,
        11,
        19,
        198,
        194
      ]
    },
    {
      "name": "deposited",
      "discriminator": [
        111,
        141,
        26,
        45,
        161,
        35,
        100,
        57
      ]
    },
    {
      "name": "mintAllowed",
      "discriminator": [
        80,
        212,
        130,
        120,
        125,
        216,
        111,
        240
      ]
    },
    {
      "name": "mintDisallowed",
      "discriminator": [
        197,
        121,
        232,
        50,
        39,
        80,
        141,
        148
      ]
    },
    {
      "name": "pauseChanged",
      "discriminator": [
        238,
        188,
        213,
        78,
        134,
        209,
        178,
        218
      ]
    },
    {
      "name": "policyUpdated",
      "discriminator": [
        225,
        112,
        112,
        67,
        95,
        236,
        245,
        161
      ]
    },
    {
      "name": "swapExecuted",
      "discriminator": [
        150,
        166,
        26,
        225,
        28,
        89,
        38,
        79
      ]
    },
    {
      "name": "vaultInitialized",
      "discriminator": [
        180,
        43,
        207,
        2,
        18,
        71,
        3,
        75
      ]
    },
    {
      "name": "withdrawn",
      "discriminator": [
        20,
        89,
        223,
        198,
        194,
        124,
        219,
        13
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notUpgradeAuthority",
      "msg": "Only the program upgrade authority may create the config"
    },
    {
      "code": 6001,
      "name": "notAdmin",
      "msg": "Signer is not the config admin"
    },
    {
      "code": 6002,
      "name": "notPendingAdmin",
      "msg": "Signer is not the pending admin"
    },
    {
      "code": 6003,
      "name": "invalidAdmin",
      "msg": "Invalid admin key"
    },
    {
      "code": 6004,
      "name": "listTooLong",
      "msg": "List exceeds its maximum length"
    },
    {
      "code": 6005,
      "name": "mintInBothLists",
      "msg": "A mint cannot be both stable and a stock"
    },
    {
      "code": 6006,
      "name": "invalidTtl",
      "msg": "Agent TTL out of range"
    },
    {
      "code": 6007,
      "name": "notOwner",
      "msg": "Signer is not the vault owner"
    },
    {
      "code": 6008,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6009,
      "name": "perTxCapAboveDaily",
      "msg": "Per-transaction cap cannot exceed the daily cap"
    },
    {
      "code": 6010,
      "name": "slippageTooHigh",
      "msg": "Max slippage above 10%"
    },
    {
      "code": 6011,
      "name": "expiryInPast",
      "msg": "Agent expiry is in the past"
    },
    {
      "code": 6012,
      "name": "expiryTooFar",
      "msg": "Agent expiry is further out than the config allows"
    },
    {
      "code": 6013,
      "name": "agentIsOwner",
      "msg": "Agent cannot be the vault owner"
    },
    {
      "code": 6014,
      "name": "vaultPaused",
      "msg": "Vault is paused"
    },
    {
      "code": 6015,
      "name": "noAgent",
      "msg": "Vault has no agent"
    },
    {
      "code": 6016,
      "name": "notAgent",
      "msg": "Signer is not the vault's agent"
    },
    {
      "code": 6017,
      "name": "agentExpired",
      "msg": "Agent authorization has expired"
    },
    {
      "code": 6018,
      "name": "sameMint",
      "msg": "Input and output mints must differ"
    },
    {
      "code": 6019,
      "name": "inputMintNotStable",
      "msg": "Input mint is not an approved stable mint"
    },
    {
      "code": 6020,
      "name": "outputMintNotAllowed",
      "msg": "Output mint is not a curated stock"
    },
    {
      "code": 6021,
      "name": "outputMintNotIssuer",
      "msg": "Output mint does not carry a recognised issuer authority"
    },
    {
      "code": 6022,
      "name": "badMint",
      "msg": "Mint account could not be parsed"
    },
    {
      "code": 6023,
      "name": "overPerTxCap",
      "msg": "Amount exceeds the per-transaction cap"
    },
    {
      "code": 6024,
      "name": "overDailyCap",
      "msg": "Amount exceeds the daily cap"
    },
    {
      "code": 6025,
      "name": "inputDebitMismatch",
      "msg": "Vault input balance did not decrease by exactly amount_in"
    },
    {
      "code": 6026,
      "name": "outputBelowMin",
      "msg": "Output received is below the minimum"
    },
    {
      "code": 6027,
      "name": "deskDisabled",
      "msg": "Desk fills are disabled"
    },
    {
      "code": 6028,
      "name": "unknownDesk",
      "msg": "Desk is not the config-approved desk"
    },
    {
      "code": 6029,
      "name": "routerDisabled",
      "msg": "Router fills are disabled"
    },
    {
      "code": 6030,
      "name": "unknownRouter",
      "msg": "Router is not the config-approved router"
    },
    {
      "code": 6031,
      "name": "routeDataTooLarge",
      "msg": "Route data too large"
    },
    {
      "code": 6032,
      "name": "unexpectedSigner",
      "msg": "A remaining account is a signer that is not the vault"
    },
    {
      "code": 6033,
      "name": "unexpectedAccount",
      "msg": "A remaining account must not be passed to the router"
    },
    {
      "code": 6034,
      "name": "agentLamportsDecreased",
      "msg": "Agent lamports decreased during the router call"
    },
    {
      "code": 6035,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "allowedMint",
      "docs": [
        "One curated stock mint and its issuer rule, at [\"allowed\", mint]."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "issuerDelegate",
            "docs": [
              "The Token-2022 PermanentDelegate the mint must carry, or None when admin curation is the only gate."
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "desk",
            "docs": [
              "OTC counterparty for `execute_swap_desk`. Pubkey::default() disables the desk path."
            ],
            "type": "pubkey"
          },
          {
            "name": "routerProgram",
            "docs": [
              "Router for `execute_swap_router` (Jupiter on mainnet). Pubkey::default() disables it."
            ],
            "type": "pubkey"
          },
          {
            "name": "stableMints",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "issuerAuthorities",
            "docs": [
              "Legacy (v1): no longer read by swaps, which use each mint's AllowedMint issuer rule.",
              "Kept so the deployed Config account keeps its layout."
            ],
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "allowedMints",
            "docs": [
              "Legacy (v1): no longer read by swaps, which require the mint's AllowedMint account.",
              "Kept so the deployed Config account keeps its layout."
            ],
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "maxAgentTtlSecs",
            "docs": [
              "Upper bound on `agent_expires_at - now` (seconds)."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "configParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "desk",
            "type": "pubkey"
          },
          {
            "name": "routerProgram",
            "type": "pubkey"
          },
          {
            "name": "stableMints",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "issuerAuthorities",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "allowedMints",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "maxAgentTtlSecs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "configUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "desk",
            "type": "pubkey"
          },
          {
            "name": "routerProgram",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "deposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "depositor",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "mintAllowed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "issuerDelegate",
            "type": {
              "option": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "mintDisallowed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "pauseChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "policyParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "agentExpiresAt",
            "type": "i64"
          },
          {
            "name": "perTxCap",
            "type": "u64"
          },
          {
            "name": "dailyCap",
            "type": "u64"
          },
          {
            "name": "maxSlippageBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "policyUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "agentExpiresAt",
            "type": "i64"
          },
          {
            "name": "perTxCap",
            "type": "u64"
          },
          {
            "name": "dailyCap",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "swapExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "inMint",
            "type": "pubkey"
          },
          {
            "name": "outMint",
            "type": "pubkey"
          },
          {
            "name": "amountIn",
            "type": "u64"
          },
          {
            "name": "amountOut",
            "type": "u64"
          },
          {
            "name": "fill",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "agentExpiresAt",
            "docs": [
              "unix seconds; 0 when no agent"
            ],
            "type": "i64"
          },
          {
            "name": "perTxCap",
            "docs": [
              "stable base units (USDC: 6 dp)"
            ],
            "type": "u64"
          },
          {
            "name": "dailyCap",
            "type": "u64"
          },
          {
            "name": "dailySpent",
            "type": "u64"
          },
          {
            "name": "dailyWindowStart",
            "docs": [
              "unix seconds; rolling window start"
            ],
            "type": "i64"
          },
          {
            "name": "maxSlippageBps",
            "type": "u16"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vaultInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "agentExpiresAt",
            "type": "i64"
          },
          {
            "name": "depositAmount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "withdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
