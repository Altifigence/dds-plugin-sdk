import {createNodeWorkspace} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createNodeProjectWatcher} from '@altifigence/dds-plugin-sdk/project-watch-node';
import {createNodeProjectQueries} from '@altifigence/dds-plugin-sdk/project-query-node';
import {parseProjectQueryOptions,parseProjectQueryPage,type ProjectQueryPage,type ProjectTextSearchOptions} from '@altifigence/dds-plugin-sdk/project-query';
const workspace=await createNodeWorkspace({root:'/operator/project'});
const watcher=await createNodeProjectWatcher({workspace,roots:['rtl'],fileSystem:'local'});
const queries=createNodeProjectQueries({watcher});
const tree:ProjectQueryPage=await queries.listTree({root:'rtl',maxDepth:3,pageSize:16});
const files=await queries.searchFiles({root:'rtl',query:'**/*.sv',mode:'glob',caseSensitive:false});
const options:ProjectTextSearchOptions={root:'rtl',query:'module',maxScanBytes:1048576};
const matches=parseProjectQueryPage(await queries.searchText(options,{signal:new AbortController().signal}));
if(matches.nextCursor){await queries.searchText({...options,cursor:matches.nextCursor});queries.releaseCursor(matches.nextCursor);}
const parsed=parseProjectQueryOptions({kind:'tree',root:'rtl'});void [tree,files,parsed];
// @ts-expect-error Explicit root is required.
queries.listTree({});
// @ts-expect-error Text search accepts literal text only.
queries.searchText({root:'rtl',query:'a',mode:'glob'});
// @ts-expect-error Query kind belongs to the selected method.
queries.listTree({root:'rtl',kind:'files'});
queries.dispose();watcher.dispose();workspace.dispose();
