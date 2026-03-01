import { createGenerator } from 'ts-json-schema-generator';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Generates JSON Schema for RootConfig and connector-specific configs at runtime
 */
export class SchemaProvider {
  private static schema: any = null;
  private static connectorSchemas: Map<string, any> = new Map();

  /**
   * Get the generated JSON schema for RootConfig
   */
  static getSchema(): any {
    if (this.schema) {
      return this.schema;
    }

    const tsConfigPath = this.getTsConfigPath();

    const generator = createGenerator({
      tsconfig: tsConfigPath,
      type: 'RootConfig',
      encodeRefs: false,
    });

    this.schema = generator.createSchema('RootConfig');
    return this.schema;
  }

  /**
   * Get the generated JSON schema for a specific connector's Config type
   * @param connectorName The connector name (e.g., 'bankin', 'wiismile')
   */
  static getConnectorSchema(connectorName: string): any {
    if (this.connectorSchemas.has(connectorName)) {
      return this.connectorSchemas.get(connectorName);
    }

    const tsConfigPath = this.getTsConfigPath();
    const projectRoot = this.getProjectRoot();
    const typesPath = path.join(
      projectRoot, 'src', 'commands', 'bank-sync', 'connectors', connectorName, 'types.ts'
    );

    try {
      const generator = createGenerator({
        tsconfig: tsConfigPath,
        path: typesPath,
        type: 'Config',
        encodeRefs: false,
      });

      const schema = generator.createSchema('Config');
      this.connectorSchemas.set(connectorName, schema);
      return schema;
    } catch (error) {
      throw new Error(`Failed to generate schema for connector "${connectorName}": ${error}`);
    }
  }

  private static getProjectRoot(): string {
    const currentFile = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(currentFile);
    // Go up one level from dist/ to reach project root
    return path.join(__dirname, '..');
  }

  private static getTsConfigPath(): string {
    return path.join(this.getProjectRoot(), 'tsconfig.json');
  }
}

