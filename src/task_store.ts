import fs from "node:fs";
import path from "node:path";

export class TaskStore {
  constructor(private storageDir: string) {}

  private tasksDir() {
    return path.join(this.storageDir, "tasks");
  }

  private taskPath(taskId: string) {
    return path.join(this.tasksDir(), `${taskId}.json`);
  }

  get(taskId: string): any | null {
    const p = this.taskPath(taskId);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  }

  put(taskId: string, obj: any) {
    fs.mkdirSync(this.tasksDir(), { recursive: true });
    fs.writeFileSync(this.taskPath(taskId), JSON.stringify(obj, null, 2), "utf-8");
  }
}