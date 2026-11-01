export interface FileDialogRequest {
  id: string
  title: string
  kind: 'open' | 'save'
  directory: boolean
  multiple: boolean
  filters: { name: string; extensions: string[] }[]
  defaultPath: string
}
