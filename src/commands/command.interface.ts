/**
 * Interface that all commands must implement
 */
export interface Command {
  /**
   * Execute the command with provided arguments
   * @param args Command-line arguments (excluding the command name itself)
   */
  execute(args: string[]): Promise<void>;

  /**
   * Get a brief description of what this command does
   */
  getDescription(): string;
}
