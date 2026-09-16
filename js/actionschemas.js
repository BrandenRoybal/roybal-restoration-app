/* GENERATED — do not edit. The proposable actions' param schemas + which app may propose which.
   Source: supabase/functions/_shared/personas/ · regenerate with
   node --experimental-strip-types supabase/functions/_shared/personas/emit-client.mjs
   personas.test.mjs fails the build if this copy drifts from the source. */
export const ACTION_SCHEMAS = {
  "sendText": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "to",
      "message",
      "audience"
    ],
    "properties": {
      "to": {
        "type": "string",
        "description": "The recipient's phone number, from the context or a lookup — never invented"
      },
      "message": {
        "type": "string",
        "description": "The complete text, sent verbatim"
      },
      "audience": {
        "type": "string",
        "enum": [
          "customer",
          "crew"
        ]
      }
    }
  },
  "boardWrite": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "job"
    ],
    "properties": {
      "job": {
        "type": "string",
        "description": "The job: customer name, address, or claim — enough to match exactly one job (or its exact id)"
      },
      "stage": {
        "type": "string",
        "enum": [
          "lead",
          "scheduled",
          "in_progress",
          "on_hold",
          "final",
          "done"
        ]
      },
      "startDate": {
        "type": "string",
        "format": "date",
        "description": "Pins the start; the engine reflows dependent jobs (YYYY-MM-DD)"
      },
      "targetDate": {
        "type": "string",
        "format": "date",
        "description": "Finish date — sets the duration (won't stick on a phased job) (YYYY-MM-DD)"
      },
      "assignedCrew": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Crew member names — REPLACES the whole crew list"
      },
      "materialStatus": {
        "type": "string",
        "enum": [
          "none",
          "ordered",
          "received"
        ]
      },
      "notes": {
        "type": "string",
        "description": "Appended to the job's notes, never overwrites"
      }
    }
  },
  "jobCreate": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "insured",
      "address",
      "lossType"
    ],
    "properties": {
      "insured": {
        "type": "string",
        "description": "The customer's name"
      },
      "address": {
        "type": "string",
        "description": "The property address"
      },
      "lossType": {
        "type": "string",
        "enum": [
          "water",
          "fire",
          "mold",
          "restoration",
          "remodel",
          "new_build",
          "other"
        ]
      },
      "startDate": {
        "type": "string",
        "format": "date",
        "description": "Pins the start (stage becomes 'scheduled') (YYYY-MM-DD)"
      },
      "targetDate": {
        "type": "string",
        "format": "date",
        "description": "Target finish (YYYY-MM-DD)"
      },
      "assignedCrew": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Crew member names"
      },
      "notes": {
        "type": "string",
        "description": "Notes for the job"
      }
    }
  },
  "crewAvailabilityWrite": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "crewMember",
      "startDate",
      "endDate",
      "available"
    ],
    "properties": {
      "crewMember": {
        "type": "string",
        "description": "Full name"
      },
      "startDate": {
        "type": "string",
        "format": "date",
        "description": "First day (YYYY-MM-DD)"
      },
      "endDate": {
        "type": "string",
        "format": "date",
        "description": "Last day, inclusive (YYYY-MM-DD)"
      },
      "available": {
        "type": "boolean",
        "description": "false blocks the days, true restores them"
      },
      "reason": {
        "type": "string",
        "description": "Why (PTO, training, injury, no-show…)"
      }
    }
  },
  "crewSwap": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "fromJob",
      "toJob",
      "crewMembers",
      "date"
    ],
    "properties": {
      "fromJob": {
        "type": "string",
        "description": "Title or customer matching exactly one job"
      },
      "toJob": {
        "type": "string",
        "description": "Title or customer matching exactly one job"
      },
      "crewMembers": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Names to move"
      },
      "date": {
        "type": "string",
        "format": "date",
        "description": "The day (YYYY-MM-DD)"
      },
      "scope": {
        "type": "string",
        "enum": [
          "day",
          "forward"
        ]
      }
    }
  },
  "hoursWrite": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "job",
      "crewMember",
      "hours"
    ],
    "properties": {
      "job": {
        "type": "string",
        "description": "Job title or customer"
      },
      "crewMember": {
        "type": "string",
        "description": "The crew member's name"
      },
      "date": {
        "type": "string",
        "format": "date",
        "description": "Omit for today (YYYY-MM-DD)"
      },
      "hours": {
        "type": "number",
        "description": "Hours worked"
      },
      "phase": {
        "type": "string",
        "description": "A phase name on that job to pin the hours to"
      },
      "trade": {
        "type": "string",
        "description": "e.g. demo / framing / drying / general"
      },
      "notes": {
        "type": "string",
        "description": "Notes"
      }
    }
  },
  "phaseUpdate": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "job",
      "phase"
    ],
    "properties": {
      "job": {
        "type": "string",
        "description": "The job: customer name, address, or claim — enough to match exactly one job (or its exact id)"
      },
      "phase": {
        "type": "string",
        "description": "The phase's name"
      },
      "done": {
        "type": "boolean",
        "description": "Default true; false reopens"
      },
      "completedOn": {
        "type": "string",
        "format": "date",
        "description": "Backdate if it wrapped earlier; default today (YYYY-MM-DD)"
      }
    }
  },
  "adjusterEmail": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "job"
    ],
    "properties": {
      "job": {
        "type": "string",
        "description": "Customer name or address, enough to match exactly one job"
      }
    }
  },
  "docRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "job",
      "items"
    ],
    "properties": {
      "job": {
        "type": "string",
        "description": "Customer name or address to match exactly one job"
      },
      "items": {
        "type": "string",
        "description": "What to ask for, in plain words"
      },
      "note": {
        "type": "string",
        "description": "Optional extra context"
      }
    }
  },
  "portalPhotoShare": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "job"
    ],
    "properties": {
      "job": {
        "type": "string",
        "description": "Customer name or address to match exactly one job"
      },
      "count": {
        "type": "number",
        "description": "How many of the newest photos to add (default 5, max 20)"
      }
    }
  },
  "emailSend": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "job",
      "to",
      "body"
    ],
    "properties": {
      "job": {
        "type": "string",
        "description": "Customer name or address to match exactly one job"
      },
      "to": {
        "type": "string",
        "enum": [
          "reply",
          "customer"
        ]
      },
      "subject": {
        "type": "string",
        "description": "Required for 'customer'; defaults to Re: the thread for 'reply'"
      },
      "body": {
        "type": "string",
        "description": "The COMPLETE email, sent verbatim"
      }
    }
  },
  "portalReply": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "job",
      "mode"
    ],
    "properties": {
      "job": {
        "type": "string",
        "description": "Customer name or address to match"
      },
      "mode": {
        "type": "string",
        "enum": [
          "reply",
          "status"
        ]
      }
    }
  },
  "estimateWrite": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "job"
    ],
    "properties": {
      "job": {
        "type": "string",
        "description": "Customer / address / claim, matching exactly one job"
      },
      "estimateId": {
        "type": "string",
        "description": "Omit to create; an existing estimate's number (e.g. 'EST-1') to update"
      },
      "lineItems": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "description",
            "quantity",
            "unit",
            "unitPrice"
          ],
          "properties": {
            "description": {
              "type": "string",
              "description": "What the line is"
            },
            "category": {
              "type": "string",
              "description": "Xactimate category code (DRY/PNT/INS/FNC/FRM/ACT/APP/LAB)"
            },
            "quantity": {
              "type": "number",
              "description": "How many units"
            },
            "unit": {
              "type": "string",
              "description": "SF / LF / EA / HR"
            },
            "unitPrice": {
              "type": "number",
              "description": "Price per unit; negative = credit. From priceLookup, quoted exactly — NEVER invented"
            },
            "type": {
              "type": "string",
              "enum": [
                "replace",
                "tearout",
                "detach_reset",
                "labor"
              ]
            }
          }
        },
        "description": "REPLACES the whole list on update; omit to keep existing lines"
      },
      "notes": {
        "type": "string",
        "description": "Notes"
      },
      "status": {
        "type": "string",
        "enum": [
          "draft",
          "pending_approval",
          "approved",
          "rejected"
        ]
      }
    }
  },
  "invoiceCreate": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "job",
      "estimateId",
      "invoiceDate",
      "dueDate",
      "billedTo"
    ],
    "properties": {
      "job": {
        "type": "string",
        "description": "The job: customer name, address, or claim — enough to match exactly one job (or its exact id)"
      },
      "estimateId": {
        "type": "string",
        "description": "The estimate's number or id"
      },
      "invoiceDate": {
        "type": "string",
        "format": "date",
        "description": "Invoice date (YYYY-MM-DD)"
      },
      "dueDate": {
        "type": "string",
        "format": "date",
        "description": "Due date (YYYY-MM-DD)"
      },
      "billedTo": {
        "type": "string",
        "description": "Customer, carrier, or entity from the job record"
      },
      "notes": {
        "type": "string",
        "description": "Notes"
      }
    }
  },
  "invoiceStatusUpdate": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "invoiceId",
      "status"
    ],
    "properties": {
      "invoiceId": {
        "type": "string",
        "description": "The invoice number (e.g. 'INV-2')"
      },
      "job": {
        "type": "string",
        "description": "Customer/claim — when the number exists on more than one job"
      },
      "status": {
        "type": "string",
        "enum": [
          "sent",
          "viewed",
          "partially_paid",
          "paid",
          "void"
        ]
      },
      "amountReceived": {
        "type": "number",
        "description": "Required for partially_paid; never more than the balance"
      },
      "paymentDate": {
        "type": "string",
        "format": "date",
        "description": "When it was paid (YYYY-MM-DD)"
      },
      "paymentMethod": {
        "type": "string",
        "description": "e.g. check / ACH / card / insurance_draft"
      },
      "notes": {
        "type": "string",
        "description": "Notes"
      }
    }
  },
  "changeOrderWrite": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "job",
      "description",
      "reason",
      "costDelta"
    ],
    "properties": {
      "job": {
        "type": "string",
        "description": "The job: customer name, address, or claim — enough to match exactly one job (or its exact id)"
      },
      "changeOrderId": {
        "type": "string",
        "description": "Omit to create"
      },
      "description": {
        "type": "string",
        "description": "What changes"
      },
      "reason": {
        "type": "string",
        "description": "e.g. 'hidden damage', 'owner request', 'code upgrade'"
      },
      "lineItems": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "description",
            "quantity",
            "unit",
            "unitPrice"
          ],
          "properties": {
            "description": {
              "type": "string",
              "description": "What the line is"
            },
            "category": {
              "type": "string",
              "description": "Xactimate category code (DRY/PNT/INS/FNC/FRM/ACT/APP/LAB)"
            },
            "quantity": {
              "type": "number",
              "description": "How many units"
            },
            "unit": {
              "type": "string",
              "description": "SF / LF / EA / HR"
            },
            "unitPrice": {
              "type": "number",
              "description": "Price per unit; negative = credit. From priceLookup, quoted exactly — NEVER invented"
            },
            "type": {
              "type": "string",
              "enum": [
                "replace",
                "tearout",
                "detach_reset",
                "labor"
              ]
            }
          }
        },
        "description": "REPLACES existing lines when provided"
      },
      "costDelta": {
        "type": "number",
        "description": "Positive adds, negative credits"
      },
      "approvalStatus": {
        "type": "string",
        "enum": [
          "pending",
          "approved",
          "rejected"
        ]
      }
    }
  },
  "receiptLog": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "job",
      "vendor",
      "amount"
    ],
    "properties": {
      "job": {
        "type": "string",
        "description": "The job: customer name, address, or claim — enough to match exactly one job (or its exact id)"
      },
      "vendor": {
        "type": "string",
        "description": "Who was paid"
      },
      "amount": {
        "type": "number",
        "description": "Dollars"
      },
      "category": {
        "type": "string",
        "description": "e.g. materials / equipment / dump / sub"
      },
      "date": {
        "type": "string",
        "format": "date",
        "description": "Omit for today (YYYY-MM-DD)"
      },
      "notes": {
        "type": "string",
        "description": "Notes"
      }
    }
  }
};

export const ACTIONSETS = {
  "field": [
    "sendText"
  ],
  "board": [
    "sendText",
    "boardWrite",
    "jobCreate",
    "crewAvailabilityWrite",
    "crewSwap",
    "hoursWrite",
    "phaseUpdate"
  ],
  "admin": [
    "sendText",
    "adjusterEmail",
    "portalReply",
    "emailSend",
    "docRequest",
    "portalPhotoShare",
    "estimateWrite",
    "invoiceCreate",
    "invoiceStatusUpdate",
    "changeOrderWrite",
    "receiptLog"
  ],
  "sms": [
    "sendText"
  ]
};
