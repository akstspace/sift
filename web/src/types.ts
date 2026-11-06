export interface CheckItem { id: string; title: string; done: boolean }
export interface Task { id:string;title:string;description:string;status:string;priority:string;project:string;tags:string[];icon:string;parentId:string;today:boolean;dueDate:string;snoozedUntil:string;checklist:CheckItem[];attachments:string[];source:string;sourceKey:string;mergedInto:string;deletedAt:string;completedAt:string;archivedAt:string;createdAt:string;updatedAt:string;actor:string;revision:number;
  /** The agent whose status change awaits the person's review; Sift sets and clears it. */
  agentChange?:string }
export interface Column { id:string;name:string;color:string;order:number }
export interface Entity { id:string;name:string;color:string;archived:boolean;icon:string }
/** One trigger: daily or selected weekdays at HH:MM, an interval such as 2h, or cron. */
export interface JobSchedule { type:string;schedule:string;weekdays?:number[] }
export interface Job { id:string;name:string;prompt:string;directory:string;provider:string;model:string;thinking:string;schedules:JobSchedule[];timezone:string;enabled:boolean;timeoutMinutes:number;sessionId:string;nextRun:string;lastRun:string;pending:boolean;includeImages:boolean;revision:number;
  /** "activity" for the activity tracker; Since is when tracking started. */
  kind?:string;since?:string;
  /** Why Sift paused the schedule itself; absent when the person paused it. */
  pausedReason?:string }
export interface Run { id:string;jobId:string;jobName:string;status:string;startedAt:string;endedAt:string;summary:string;error:string;model:string;sessionId:string;job:Job;
  /** The stretches of time an activity check looks through. */
  windows?:ActivityWindow[] }
export interface Settings { id:string;onboarded:boolean;timezone:string;theme:string;view:string;concurrency:number;timeoutMinutes:number;checkUpdates:boolean;desktopNotifications:boolean;backupRetention:number;logRetentionDays:number;trashRetentionDays:number;autoArchiveDays:number;lastBackup:string;backupError:string }
export interface Notification { id:string;title:string;message:string;read:boolean;at:string }
export interface Attachment { id:string;name:string;mime:string;size:number;width:number;height:number;hash:string }
export interface Snapshot {cursor:number;version:string;tasks:Task[];columns:Column[];projects:Entity[];tags:Entity[];jobs:Job[];runs:Run[];attachments:Attachment[];notifications:Notification[];settings:Settings}
export interface HistoryEntry {id:number;kind:string;entityId:string;actor:string;reason:string;at:string;before?:Task;after?:Task;group?:string}
export interface Duplicate {id:string;title:string;status:string;score:number;reasons:string[]}
export interface CatalogIcon {id:string;name:string;category:string;aliases:string[];symbol?:string}
export interface PiModel {id:string;name:string;provider:string;reasoning:boolean;input:string[];contextWindow:number}
export interface PiInfo {connected:boolean;version:string;path:string;models:PiModel[];thinking:{levels?:unknown[]};state:{model?:PiModel;thinkingLevel?:string}}
export const newTask = (parentId=''):Task=>({id:'',title:'',description:'',status:'open',priority:'none',project:'',tags:[],icon:'circle-check',parentId,today:true,dueDate:'',snoozedUntil:'',checklist:[],attachments:[],source:'user',sourceKey:'',mergedInto:'',deletedAt:'',completedAt:'',archivedAt:'',createdAt:'',updatedAt:'',actor:'user',revision:0})
/** One work session on My activity. Times are UTC instants. */
export interface ActivityEntry {id:string;start:string;end:string;title:string;summary:string;category:string;source:string;link:string;taskId:string;sourceKey:string;actor:string;edited?:boolean;createdAt:string;updatedAt:string;revision:number}
export interface ActivityWindow {from:string;to:string}
export interface ActivityCheck {id:string;from:string;to:string;runId:string;at:string}
export interface ActivityPage {entries:ActivityEntry[];checks:ActivityCheck[];gaps:ActivityWindow[];tracker:Job|null;defaultPrompt:string;defaultTimes:string[];categories:string[];lookbackDays:number}
