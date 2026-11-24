import { z } from "zod";

export type JsonSchemaType =
  "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";

/** The JSON Schema subset understood by Gemini and by the Pi TypeBox bridge. */
export interface RestrictedJsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, RestrictedJsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: RestrictedJsonSchema;
  anyOf?: RestrictedJsonSchema[];
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  description?: string;
  default?: unknown;
}

function restricted(value: unknown): RestrictedJsonSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Unsupported Zod JSON Schema: ${JSON.stringify(value)}`);
  }
  const input = value as Record<string, unknown>;
  const output: RestrictedJsonSchema = {};
  if (typeof input.description === "string") output.description = input.description;
  if ("default" in input) output.default = input.default;
  if (typeof input.minimum === "number") output.minimum = input.minimum;
  if (typeof input.maximum === "number") output.maximum = input.maximum;

  if (Array.isArray(input.anyOf)) {
    output.anyOf = input.anyOf.map(restricted);
    return output;
  }
  if (Array.isArray(input.enum)) {
    if (input.enum.length === 0) throw new Error("Zod produced an empty enum");
    if (!input.enum.every((v) => ["string", "number", "boolean"].includes(typeof v))) {
      throw new Error("Only string, number, and boolean enum literals are supported");
    }
    output.enum = input.enum;
  }

  const type = input.type;
  if (Array.isArray(type)) {
    if (!type.every((v): v is JsonSchemaType => typeof v === "string")) {
      throw new Error("Invalid JSON Schema type array");
    }
    output.type = type;
  } else if (typeof type === "string") {
    output.type = type as JsonSchemaType;
  } else if (!output.enum) {
    throw new Error(`Unsupported Zod JSON Schema type: ${JSON.stringify(input)}`);
  }

  const types = Array.isArray(output.type) ? output.type : [output.type];
  if (types.includes("object")) {
    const properties = input.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      throw new Error("An object schema requires properties");
    }
    output.properties = Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => [key, restricted(schema)]),
    );
    if (input.required !== undefined) {
      if (!Array.isArray(input.required) || !input.required.every((v) => typeof v === "string")) {
        throw new Error("Invalid required property list");
      }
      output.required = input.required;
    }
    output.additionalProperties = false;
  }
  if (types.includes("array")) output.items = restricted(input.items);
  return output;
}

/** Convert a tool's real Zod v4 input shape without losing validation bounds. */
export function zodShapeToRestrictedJsonSchema(shape: z.ZodRawShape): RestrictedJsonSchema {
  const schema = z.toJSONSchema(z.object(shape).strict(), {
    io: "input",
    unrepresentable: "throw",
  });
  return restricted(schema);
}

/** Gemini rejects an empty-string enum member; retain it as prompt guidance. */
export function forGeminiSchema(schema: RestrictedJsonSchema): RestrictedJsonSchema {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const output: Record<string, unknown> = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, visit(child)]),
    );
    if (Array.isArray(output.enum) && output.enum.includes("")) {
      const values = output.enum.map((v) => JSON.stringify(v)).join(", ");
      delete output.enum;
      output.description = [output.description, `One of ${values}`].filter(Boolean).join(". ");
    }
    return output;
  };
  return visit(schema) as RestrictedJsonSchema;
}

export function assertNoEmptyEnum(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const value of schema) assertNoEmptyEnum(value);
    return;
  }
  if (!schema || typeof schema !== "object") return;
  const record = schema as Record<string, unknown>;
  if (
    Array.isArray(record.enum) &&
    (record.enum.length === 0 || record.enum.some((value) => value === ""))
  ) {
    throw new Error("Panel schemas must not contain an empty enum or an empty-string enum member");
  }
  for (const value of Object.values(record)) assertNoEmptyEnum(value);
}
